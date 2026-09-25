/**
 * Runs the bootstrap steps a `thread.turn.start` command can carry
 * (`command.bootstrap`): create the thread, prepare its git worktree, launch the
 * project setup script, then dispatch the plain turn start. A failure after the
 * thread was created rolls it back with `thread.delete`.
 *
 * Shared by every transport that dispatches client commands (WebSocket RPC and
 * the HTTP dispatch route) so both behave identically.
 */
import {
  CommandId,
  EventId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  worktreeSetupActivityId,
  type WorktreeSetupSnapshot,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";

export type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface TurnStartBootstrapDispatchOptions {
  readonly origin?: OrchestrationClientOrigin;
}

export class TurnStartBootstrap extends Context.Service<
  TurnStartBootstrap,
  {
    readonly dispatchTurnStart: (
      command: TurnStartCommand,
      options?: TurnStartBootstrapDispatchOptions,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/TurnStartBootstrap") {}

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Preserve the setup runner's broader pre-refactor message normalization. */
function setupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return setupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isOrchestrationDispatchCommandError(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message: error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  // Project setting > environment setting; null when neither is set so
  // the driver reads the freshly created checkout's own t3.json (the
  // branch being checked out may declare something the project root does
  // not). Settings that fail to load fall through the same way.
  const resolveBootstrapWorktreeSubmodules = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | null;
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings) return null;
    // A worktree can also be prepared for an existing thread, whose
    // project is only known through its shell.
    const resolvedProjectId =
      input.projectId ??
      (yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.map((thread) => Option.getOrNull(thread)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      ));
    const project =
      resolvedProjectId === null
        ? null
        : yield* projectionSnapshotQuery.getProjectShellById(resolvedProjectId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          );
    return resolveProjectSettings(settings, resolvedProjectId, project).settings.worktreeSubmodules;
  });

  const dispatchTurnStart = (
    command: TurnStartCommand,
    options?: TurnStartBootstrapDispatchOptions,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      // Every sub-command the bootstrap emits carries whatever origin the
      // transport supplied: the WebSocket path passes its client origin so the
      // sub-commands attribute to the request that caused them; HTTP dispatch
      // passes none, as its plain dispatch path never has.
      const dispatch = (subCommand: OrchestrationCommand) =>
        orchestrationEngine.dispatch(subCommand, options);

      // The worktree setup's durable record: one activity per thread, upserted
      // by a fixed id when the setup starts and again when it settles. Live
      // progress keeps streaming from the tracker; this is what a reload or
      // another client reads. Best effort: the thread may already be gone
      // after a failed bootstrap.
      const recordWorktreeSetup = (snapshot: WorktreeSetupSnapshot) =>
        serverCommandId("worktree-setup-activity").pipe(
          Effect.flatMap((commandId) =>
            dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: snapshot.threadId,
              activity: {
                id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
                tone:
                  snapshot.phase === "failed" ||
                  snapshot.stages.some((stage) => stage.status === "failed")
                    ? "error"
                    : "info",
                kind: WORKTREE_SETUP_ACTIVITY_KIND,
                summary:
                  snapshot.phase === "running"
                    ? "Setting up worktree"
                    : snapshot.phase === "done"
                      ? "Worktree ready"
                      : snapshot.phase === "cancelled"
                        ? "Worktree setup cancelled"
                        : "Worktree setup failed",
                payload: snapshot,
                turnId: null,
                createdAt: snapshot.startedAt,
              },
              createdAt: snapshot.endedAt ?? snapshot.startedAt,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
      // The setup script's terminal, once started. Cancel closes only this
      // one so terminals the user opened meanwhile survive.
      let setupTerminalId: string | null = null;

      // Set once the checkout starts; see the session.set below.
      let preparingSessionSet = false;
      const markPreparingSessionFailed = (detail: string) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          yield* dispatch({
            type: "thread.session.set",
            commandId: yield* serverCommandId("bootstrap-thread-preparing-failed"),
            threadId,
            session: {
              threadId,
              status: "error",
              providerName: null,
              providerInstanceId:
                bootstrap?.createThread?.modelSelection.instanceId ??
                command.modelSelection?.instanceId,
              runtimeMode: command.runtimeMode,
              activeTurnId: null,
              lastError: detail.trim().length > 0 ? detail : "Worktree setup failed.",
              updatedAt: failedAt,
            },
            createdAt: failedAt,
          });
        });
      const cleanupCreatedThread = () =>
        createdThread
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: command.threadId,
                }),
              ),
              Effect.as(true),
            )
          : Effect.succeed(false);

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = projectSetupScriptCompatibilityDetail(input.error);
        return appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: input.requestedAt,
          payload: {
            detail,
            worktreePath: input.worktreePath,
          },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: startedAt,
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const tracked = bootstrap?.prepareWorktree !== undefined;
      const threadId = command.threadId;
      const track = (effect: Effect.Effect<void>) => (tracked ? effect : Effect.void);

      // Starts the setup script. For tracked bootstraps it returns the
      // effect that waits for the script to exit and records the outcome
      // on the card; whether the agent stage waits on it depends on the
      // script's `async` flag. Returns null when nothing is left to await.
      // Untracked callers keep the old fire-and-forget behavior.
      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "skipped"));
            return null;
          }
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "running"));
          const setupResult = yield* projectSetupScriptRunner
            .runForThread({
              threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
              ...(tracked
                ? {
                    observeCompletion: {
                      onOutputLine: (line) =>
                        worktreeSetupTracker.appendTail(threadId, "setup-script", line),
                    },
                  }
                : {}),
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  }).pipe(
                    Effect.andThen(
                      track(
                        worktreeSetupTracker.stageStatus(
                          threadId,
                          "setup-script",
                          "failed",
                          "failed to start",
                        ),
                      ),
                    ),
                    Effect.as(null),
                  ),
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return track(
                      worktreeSetupTracker.stageStatus(
                        threadId,
                        "setup-script",
                        "skipped",
                        "no setup script",
                      ),
                    ).pipe(Effect.as(null));
                  }
                  setupTerminalId = setupResult.terminalId;
                  return recordSetupScriptStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: setupResult.scriptId,
                    scriptName: setupResult.scriptName,
                    terminalId: setupResult.terminalId,
                  }).pipe(
                    Effect.andThen(
                      track(
                        worktreeSetupTracker.update(threadId, (snapshot) => ({
                          ...snapshot,
                          setupScript: {
                            name: setupResult.scriptName,
                            command: setupResult.scriptCommand,
                            terminalId: setupResult.terminalId,
                          },
                        })),
                      ),
                    ),
                    Effect.as(setupResult),
                  );
                },
              }),
            );
          if (!tracked || !setupResult?.completion) {
            return null;
          }
          // The setup script is best effort, like the untracked path: a
          // failed install must not throw away the worktree the user just
          // waited for. The card keeps the failed stage and its terminal.
          // Forked right away so the terminal listener behind `completion`
          // is always consumed, even when the turn dispatch fails before
          // anyone would otherwise wait on it. The tracker update is a
          // no-op once the snapshot has been dropped.
          const completionFiber = yield* setupResult.completion.pipe(
            Effect.flatMap((completion) => {
              if (completion.exitCode === 0) {
                return worktreeSetupTracker.stageStatus(threadId, "setup-script", "done");
              }
              const detail =
                completion.exitCode === null
                  ? "terminal closed before the script finished"
                  : `exit ${completion.exitCode}`;
              return worktreeSetupTracker.stageStatus(threadId, "setup-script", "failed", detail);
            }),
            Effect.forkDetach,
          );
          if (!setupResult.async) {
            yield* Fiber.join(completionFiber);
            return null;
          }
          return completionFiber;
        });

      const bootstrapProgram = Effect.gen(function* () {
        const prepareWorktree = bootstrap?.prepareWorktree;
        let shouldPrepareWorktree = prepareWorktree
          ? yield* gitWorkflow.isRepository(prepareWorktree.projectCwd)
          : false;
        let worktreeBaseRef = prepareWorktree?.baseBranch ?? null;

        if (prepareWorktree && shouldPrepareWorktree) {
          // "Start from origin" is a stored default; repos without the
          // requested remote branch fall back to the local base branch.
          const startFromOrigin =
            prepareWorktree.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: prepareWorktree.projectCwd,
              remoteName: "origin",
            }));
          if (startFromOrigin) {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "running"));
            yield* gitWorkflow.fetchRemote({
              cwd: prepareWorktree.projectCwd,
              remoteName: "origin",
              refName: prepareWorktree.baseBranch,
            });
            const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
              cwd: prepareWorktree.projectCwd,
              refName: prepareWorktree.baseBranch,
              remoteName: "origin",
            });
            if (remoteBaseExists) {
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: prepareWorktree.projectCwd,
                refName: prepareWorktree.baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
              yield* track(
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "fetch",
                  "done",
                  `origin/${prepareWorktree.baseBranch} at ${resolvedRemoteBase.commitSha.slice(0, 7)}`,
                ),
              );
            } else {
              yield* track(
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "fetch",
                  "warning",
                  `origin/${prepareWorktree.baseBranch} not found, using local branch`,
                ),
              );
            }
          } else {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "skipped"));
          }

          const resolvedWorktreeBaseRef = worktreeBaseRef ?? prepareWorktree.baseBranch;
          shouldPrepareWorktree = yield* gitWorkflow.hasCommit({
            cwd: prepareWorktree.projectCwd,
            refName: resolvedWorktreeBaseRef,
          });
          worktreeBaseRef = resolvedWorktreeBaseRef;
          yield* track(
            worktreeSetupTracker.update(threadId, (snapshot) => ({
              ...snapshot,
              baseRef: resolvedWorktreeBaseRef,
            })),
          );
        }

        if (prepareWorktree && !shouldPrepareWorktree) {
          if (prepareWorktree.requireWorktree) {
            return yield* new OrchestrationDispatchCommandError({
              message:
                "A separate worktree requires a Git repository and a base branch with a commit.",
            });
          }
          // Not a git repo, or the base has no commit: the thread runs in
          // the project checkout instead. The card says so and moves on.
          yield* track(
            worktreeSetupTracker.update(threadId, (snapshot) => ({
              ...snapshot,
              stages: snapshot.stages.map((stage) =>
                stage.id === "fetch" || stage.id === "checkout" || stage.id === "submodules"
                  ? { ...stage, status: "skipped", detail: "using project checkout" }
                  : stage,
              ),
            })),
          );
        }

        if (bootstrap?.createThread) {
          const created = yield* dispatch({
            type: "thread.create",
            commandId: yield* serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            createdAt: bootstrap.createThread.createdAt,
          });
          // The successful create is a fence in the engine command queue:
          // every delete for the prior incarnation committed before it.
          // Drain through that event before setup or turn start can own
          // terminals and provider sessions under the reused thread id.
          createdThread = true;
          yield* threadDeletionReactor.drainThrough(created.sequence);
          // Persist the send now rather than with the turn: the thread is
          // real from here on, so any client (or a reload) sees the message
          // while the worktree is still being prepared. The turn start
          // later references this id instead of re-sending the text.
          yield* dispatch({
            type: "thread.message.user.append",
            commandId: yield* serverCommandId("bootstrap-thread-message"),
            threadId: command.threadId,
            message: {
              messageId: command.message.messageId,
              text: command.message.text,
              attachments: command.message.attachments,
              ...(command.message.context !== undefined
                ? { context: command.message.context }
                : {}),
            },
            createdAt: command.createdAt,
          });
          if (tracked) {
            const running = yield* worktreeSetupTracker.get(threadId);
            if (running) yield* recordWorktreeSetup(running);
          }
        }

        if (prepareWorktree && shouldPrepareWorktree && worktreeBaseRef) {
          if (bootstrap?.createThread && createdThread) {
            // The checkout and setup script can run for minutes before the
            // turn starts, and the created thread carries no message or
            // turn until then. Project a starting session now so every
            // client lists the thread as working and a reopened thread
            // knows to follow the setup stream. A failed or cancelled setup
            // deletes the thread, so nothing lingers.
            const preparingAt = yield* nowIso;
            yield* dispatch({
              type: "thread.session.set",
              commandId: yield* serverCommandId("bootstrap-thread-preparing"),
              threadId,
              session: {
                threadId,
                status: "starting",
                providerName: null,
                providerInstanceId: bootstrap.createThread.modelSelection.instanceId,
                runtimeMode: command.runtimeMode,
                activeTurnId: null,
                lastError: null,
                updatedAt: preparingAt,
              },
              createdAt: preparingAt,
            });
            preparingSessionSet = true;
          }
          yield* worktreeSetupTracker.stageStatus(threadId, "checkout", "running");
          let checkoutTotal: number | null = null;
          const submodules = yield* resolveBootstrapWorktreeSubmodules({
            threadId,
            projectId: targetProjectId ?? null,
          });
          const worktree = yield* gitWorkflow.createWorktree(
            {
              cwd: prepareWorktree.projectCwd,
              refName: worktreeBaseRef,
              newRefName: prepareWorktree.branch,
              baseRefName: prepareWorktree.baseBranch,
              path: null,
            },
            {
              submodules,
              progress: {
                // Git has registered the directory at this point, so a
                // cancel during the submodule step can still remove it.
                onWorktreeClaimed: (path) =>
                  Effect.sync(() => {
                    targetWorktreePath = path;
                  }),
                onCheckoutProgress: ({ percent, completed, total }) => {
                  checkoutTotal = total;
                  return worktreeSetupTracker.stage(threadId, "checkout", {
                    percent,
                    detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                  });
                },
                onSubmodulesStarted: () =>
                  worktreeSetupTracker
                    .stageStatus(
                      threadId,
                      "checkout",
                      "done",
                      checkoutTotal === null
                        ? null
                        : `${checkoutTotal.toLocaleString("en-US")} files`,
                    )
                    .pipe(
                      Effect.andThen(
                        worktreeSetupTracker.stageStatus(threadId, "submodules", "running"),
                      ),
                    ),
                onSubmodulesDisabled: ({ source }) =>
                  worktreeSetupTracker.stageStatus(
                    threadId,
                    "submodules",
                    "skipped",
                    `disabled in ${source}`,
                  ),
                onSubmoduleLine: (line) => {
                  const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                  return submodulePath === undefined
                    ? Effect.void
                    : worktreeSetupTracker.stage(threadId, "submodules", {
                        detail: submodulePath,
                      });
                },
                onSubmodulesFinished: ({ ok, detail }) =>
                  worktreeSetupTracker.stageStatus(
                    threadId,
                    "submodules",
                    ok ? "done" : "warning",
                    ok ? undefined : (detail ?? "submodule checkout failed"),
                  ),
              },
            },
          );
          const checkoutEndedAt = yield* nowIso;
          yield* worktreeSetupTracker.update(threadId, (snapshot) => ({
            ...snapshot,
            worktreePath: worktree.worktree.path,
            stages: snapshot.stages.map((stage) => {
              if (stage.id === "checkout" && stage.status === "running") {
                return {
                  ...stage,
                  status: "done",
                  percent: 100,
                  endedAt: checkoutEndedAt,
                  detail:
                    checkoutTotal === null
                      ? stage.detail
                      : `${checkoutTotal.toLocaleString("en-US")} files`,
                };
              }
              if (stage.id === "submodules" && stage.status === "pending") {
                return { ...stage, status: "skipped", detail: "none" };
              }
              return stage;
            }),
          }));
          targetWorktreePath = worktree.worktree.path;
          yield* dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        const pendingSetupScript = yield* runSetupProgram();

        yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "running"));
        // Past this point a cancel would roll back a thread whose turn has
        // started. Drop the cancel handle and make the handoff atomic.
        yield* track(worktreeSetupTracker.markUncancellable(threadId));
        const started = yield* Effect.uninterruptible(dispatch(finalTurnStartCommand));
        yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "done"));
        // An async setup script outlives the handoff: the snapshot stays
        // running so the client keeps its row next to the agent's work,
        // and settles when the script exits. The turn already started, so
        // the wait cannot fail the dispatch.
        const settle = tracked
          ? worktreeSetupTracker
              .finish(threadId, "done")
              .pipe(
                Effect.flatMap((snapshot) =>
                  snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                ),
              )
          : Effect.void;
        if (pendingSetupScript) {
          yield* Fiber.join(pendingSetupScript).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.andThen(settle),
            Effect.forkDetach,
          );
        } else {
          yield* settle;
        }
        return started;
      });

      const cleanupAndFail = (
        cause: Cause.Cause<unknown>,
        dispatchError: OrchestrationDispatchCommandError,
      ) =>
        Effect.uninterruptible(cleanupCreatedThread()).pipe(
          Effect.matchCauseEffect({
            onFailure: (cleanupCause) =>
              Effect.logWarning("bootstrap thread cleanup failed", {
                threadId,
                detail: Cause.pretty(cleanupCause),
              }).pipe(
                // The thread outlived its setup. Its preparing session
                // must not read as working forever, so record the failure
                // on it instead.
                Effect.andThen(
                  preparingSessionSet
                    ? markPreparingSessionFailed(dispatchError.message).pipe(
                        Effect.ignoreCause({ log: true }),
                      )
                    : Effect.void,
                ),
                Effect.flatMap(() => Effect.fail(dispatchError)),
              ),
            onSuccess: (threadDeleted) =>
              Effect.fail(
                threadDeleted ||
                  (bootstrap?.createThread &&
                    bootstrap.prepareWorktree?.requireWorktree === true &&
                    !createdThread)
                  ? new OrchestrationDispatchCommandError({
                      message: dispatchError.message,
                      ...(dispatchError.cause !== undefined ? { cause: dispatchError.cause } : {}),
                      bootstrapThreadDisposition: threadDeleted ? "deleted" : "not-created",
                    })
                  : dispatchError,
              ),
          }),
        );

      const settledBootstrapProgram = bootstrapProgram.pipe(
        Effect.interruptible,
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            // A user cancel interrupts the forked bootstrap fiber. The
            // created thread is rolled back like any other failure so the
            // draft returns to the composer. The setup terminal is closed
            // first so a still-running script cannot hold files open in
            // the worktree while git removes it. Closing kills the
            // process asynchronously, so the removal retries briefly.
            const closeSetupTerminal = setupTerminalId
              ? terminalManager.close({
                  threadId,
                  terminalId: setupTerminalId,
                  deleteHistory: true,
                })
              : Effect.void;
            const removeCreatedWorktree =
              tracked && targetWorktreePath && bootstrap?.prepareWorktree
                ? closeSetupTerminal.pipe(
                    Effect.ignoreCause({ log: true }),
                    Effect.andThen(
                      gitWorkflow
                        .removeWorktree({
                          cwd: bootstrap.prepareWorktree.projectCwd,
                          path: targetWorktreePath,
                          force: true,
                        })
                        .pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") })),
                    ),
                    Effect.ignoreCause({ log: true }),
                    Effect.uninterruptible,
                  )
                : Effect.void;
            return track(
              worktreeSetupTracker
                .finish(threadId, "cancelled")
                .pipe(
                  Effect.flatMap((snapshot) =>
                    snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                  ),
                ),
            ).pipe(
              Effect.andThen(removeCreatedWorktree),
              Effect.andThen(
                tracked
                  ? cleanupAndFail(
                      cause,
                      new OrchestrationDispatchCommandError({
                        message: "Worktree setup cancelled.",
                      }),
                    )
                  : Effect.fail(dispatchError),
              ),
            );
          }
          return track(
            worktreeSetupTracker
              .finish(threadId, "failed", dispatchError.message)
              .pipe(
                Effect.flatMap((snapshot) =>
                  snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                ),
              ),
          ).pipe(Effect.andThen(cleanupAndFail(cause, dispatchError)));
        }),
        // Cancellation must finish recording and rollback after the bootstrap is interrupted.
        Effect.uninterruptible,
      );

      // The bootstrap outlives the connection that asked for it: a reload
      // or a dropped socket must not abandon a half-made worktree, and
      // the thread it created is already visible to every client. The
      // RPC only waits on the detached fiber; a user cancel interrupts it
      // through the tracker.
      const runBootstrap = tracked
        ? Effect.gen(function* () {
            // Fork and register as one step: a detached fiber keeps going
            // if the caller is interrupted, so it must never exist without
            // the tracker entry that cancel and the stage updates key on.
            const fiber = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const fiber = yield* Effect.forkDetach(settledBootstrapProgram);
                yield* worktreeSetupTracker.begin({
                  threadId,
                  branch: bootstrap?.prepareWorktree?.branch ?? null,
                  baseRef: bootstrap?.prepareWorktree?.baseBranch ?? null,
                  stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
                  fiber,
                });
                return fiber;
              }),
            );
            return yield* Fiber.join(fiber);
          })
        : settledBootstrapProgram;

      return yield* runBootstrap;
    });

  return TurnStartBootstrap.of({ dispatchTurnStart });
});

export const layer = Layer.effect(TurnStartBootstrap, make);
