// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProviderDriverKind,
  ThreadId,
  attachedClaudeThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "@effect/vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AttachedSessions from "./AttachedSessions.ts";
import {
  ClaudeAgentsRoster,
  isClaudeMemObserverSession,
  type ClaudeAgentsRosterEntry,
  type ClaudeAgentsRosterSnapshot,
} from "./ClaudeAgentsRoster.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const threadId = attachedClaudeThreadId(SESSION_ID);

const record = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
const userRecord = (uuid: string, text: string, timestamp = "2026-09-18T10:00:00.000Z") =>
  record({
    type: "user",
    uuid,
    timestamp,
    gitBranch: "main",
    message: { role: "user", content: text },
  });
const toolResultRecord = (uuid: string, toolUseId: string) =>
  record({
    type: "user",
    uuid,
    timestamp: "2026-09-18T10:00:02.000Z",
    toolUseResult: {},
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] },
  });
const assistantRecord = (uuid: string, content: ReadonlyArray<unknown>) =>
  record({
    type: "assistant",
    uuid,
    timestamp: "2026-09-18T10:00:01.000Z",
    message: { role: "assistant", model: "claude-test", content },
  });

function createHarness(options?: { readonly enabled?: boolean }) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attached-"));
  const cwd = NodePath.join(root, "workspace");
  const configDir = NodePath.join(root, "claude");
  const transcriptDir = NodePath.join(configDir, "projects", "-workspace");
  const transcriptPath = NodePath.join(transcriptDir, `${SESSION_ID}.jsonl`);
  NodeFS.mkdirSync(cwd, { recursive: true });
  NodeFS.mkdirSync(transcriptDir, { recursive: true });

  let snapshot: Option.Option<ClaudeAgentsRosterSnapshot> = Option.none();
  let ownedBindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata> = [];
  const rosterLayer = Layer.succeed(ClaudeAgentsRoster, {
    snapshot: Effect.sync(() => snapshot),
  });

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const baseLayer = Layer.empty.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(rosterLayer),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        recordImportedTranscript: () => Effect.void,
        getProvider: () => Effect.die("unused"),
        getBinding: () => Effect.succeedNone,
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.sync(() => ownedBindings),
      }),
    ),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ enableAttachedSessions: options?.enabled ?? true }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(cwd, root)),
    Layer.provideMerge(NodeServices.layer),
  );
  /** A fresh service instance has no memory of earlier sweeps, like a restarted server. */
  const startServiceWith = (serviceOptions?: AttachedSessions.AttachedSessionsLiveOptions) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.build(AttachedSessions.makeLayer(serviceOptions)).pipe(
        Scope.provide(scope),
      );
      const service = Context.get(context, AttachedSessions.AttachedSessions);
      return {
        sweep: service.sweep("roster").pipe(Effect.andThen(service.drain)),
        close: Scope.close(scope, Exit.void),
      };
    });
  const startService = startServiceWith();
  const setRoster = (entry: Partial<ClaudeAgentsRosterEntry> | null | "probe-failed") => {
    snapshot =
      entry === "probe-failed"
        ? Option.none()
        : Option.some({
            configDir,
            sessions:
              entry === null
                ? []
                : [
                    {
                      sessionId: SESSION_ID,
                      cwd,
                      name: "demo",
                      status: "idle",
                      waitingFor: null,
                      startedAt: null,
                      ...entry,
                    },
                  ],
          });
  };

  const thread = Effect.flatMap(Effect.service(ProjectionSnapshotQuery), (query) =>
    query.getThreadDetailById(threadId),
  ).pipe(Effect.map(Option.getOrUndefined));
  const shell = Effect.flatMap(Effect.service(ProjectionSnapshotQuery), (query) =>
    query.getThreadShellById(threadId),
  ).pipe(Effect.map(Option.getOrUndefined));
  const latestSequence = Effect.flatMap(
    Effect.service(OrchestrationEngineService),
    (engine) => engine.latestSequence,
  );

  return {
    append: (text: string) => NodeFS.appendFileSync(transcriptPath, text),
    /** Marks the session as one T3 Code runs itself, with the given binding status. */
    setOwnedByT3: (status: "running" | "stopped") => {
      ownedBindings = [
        {
          threadId: ThreadId.make("t3-owned-thread"),
          provider: ProviderDriverKind.make("claudeAgent"),
          status,
          resumeCursor: { threadId: "t3-owned-thread", resume: SESSION_ID },
          lastSeenAt: "2026-09-18T10:00:00.000Z",
        },
      ];
    },
    storedAttachmentBytes: (fileName: string) =>
      NodeFS.statSync(NodePath.join(root, "userdata", "attachments", fileName)).size,
    setRoster,
    startService,
    startServiceWith,
    rewriteTranscript: (text: string) => NodeFS.writeFileSync(transcriptPath, text),
    dispatchThreadCommand: (type: "thread.archive" | "thread.unarchive" | "thread.delete") =>
      Effect.flatMap(Effect.service(OrchestrationEngineService), (engine) =>
        engine.dispatch({ type, commandId: CommandId.make(`test:${type}`), threadId }),
      ),
    setEnabled: (enabled: boolean) =>
      Effect.flatMap(Effect.service(ServerSettingsService), (settings) =>
        settings.updateSettings({ enableAttachedSessions: enabled }),
      ),
    thread,
    shell,
    latestSequence,
    /** Runs a test body against this harness's own database and temp directory. */
    run: <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof baseLayer>>) =>
      body.pipe(
        Effect.provide(baseLayer),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      ),
  };
}

describe("AttachedSessions", () => {
  it.effect("backfills an existing conversation, then mirrors new records exactly once", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Fix the bug"));
        harness.append(assistantRecord("a1", [{ type: "text", text: "On it." }]));
        harness.setRoster({ status: "busy" });
        const service = yield* harness.startService;

        yield* service.sweep;
        const attached = yield* harness.thread;
        expect(attached?.title).toBe("⌁ demo");
        expect(attached?.branch).toBe("main");
        expect(attached?.modelSelection.model).toBe("claude-test");
        expect(attached?.messages.map((message) => [message.role, message.text])).toEqual([
          ["user", "Fix the bug"],
          ["assistant", "On it."],
        ]);
        expect(attached?.session?.status).toBe("running");

        harness.append(
          assistantRecord("a2", [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
          ]),
        );
        harness.append(
          record({
            type: "user",
            uuid: "u2",
            timestamp: "2026-09-18T10:00:02.000Z",
            toolUseResult: {},
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1" }] },
          }),
        );
        harness.append(assistantRecord("a3", [{ type: "text", text: "Done." }]));
        // A record still being written has no newline yet and must wait for the next sweep.
        harness.append('{"type":"assistant","uuid":"a4"');
        yield* service.sweep;

        const mirrored = yield* harness.thread;
        expect(mirrored?.messages.map((message) => message.text)).toEqual([
          "Fix the bug",
          "On it.",
          "Done.",
        ]);
        expect(mirrored?.messages.at(-1)?.streaming).toBe(false);
        expect(
          mirrored?.activities.map((activity) => [
            activity.kind,
            activity.summary,
            activity.payload,
          ]),
        ).toEqual([
          [
            "tool.updated",
            "Bash",
            {
              itemType: "command_execution",
              toolCallId: "tool-1",
              status: "inProgress",
              title: "Bash",
              detail: "ls",
            },
          ],
          [
            "tool.completed",
            "Bash",
            {
              itemType: "command_execution",
              toolCallId: "tool-1",
              status: "completed",
              title: "Bash",
              detail: "ls",
            },
          ],
        ]);

        const settledSequence = yield* harness.latestSequence;
        yield* service.sweep;
        expect(yield* harness.latestSequence).toBe(settledSequence);
        yield* service.close;
      }),
    );
  });

  it.effect("maps waiting to a pending approval and a vanished session to stopped", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Deploy"));
        harness.setRoster({ status: "waiting", waitingFor: "permission prompt" });
        const service = yield* harness.startService;

        yield* service.sweep;
        expect((yield* harness.shell)?.hasPendingApprovals).toBe(true);
        expect((yield* harness.shell)?.session?.status).toBe("running");

        harness.setRoster({ status: "idle" });
        yield* service.sweep;
        expect((yield* harness.shell)?.hasPendingApprovals).toBe(false);
        expect((yield* harness.shell)?.session?.status).toBe("ready");

        // A failed probe says nothing about which sessions are alive.
        harness.setRoster("probe-failed");
        const beforeFailedProbe = yield* harness.latestSequence;
        yield* service.sweep;
        expect(yield* harness.latestSequence).toBe(beforeFailedProbe);

        harness.setRoster(null);
        yield* service.sweep;
        expect((yield* harness.shell)?.session?.status).toBe("stopped");
        expect((yield* harness.thread)?.deletedAt).toBeNull();
        yield* service.close;
      }),
    );
  });

  it.effect("catches up after a restart without repeating history", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "First"));
        harness.setRoster({ status: "busy" });
        const first = yield* harness.startService;
        yield* first.sweep;
        yield* first.close;

        harness.append(
          assistantRecord("a1", [{ type: "text", text: "Written while T3 was down" }]),
        );
        const second = yield* harness.startService;
        yield* second.sweep;

        expect((yield* harness.thread)?.messages.map((message) => message.text)).toEqual([
          "First",
          "Written while T3 was down",
        ]);

        // The session ended while the server was down the second time.
        yield* second.close;
        harness.setRoster(null);
        const third = yield* harness.startService;
        yield* third.sweep;
        expect((yield* harness.shell)?.session?.status).toBe("stopped");
        yield* third.close;
      }),
    );
  });

  it.effect("mirrors an image pasted into the terminal as a message attachment", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Start"));
        harness.setRoster({ status: "busy" });
        const service = yield* harness.startService;
        yield* service.sweep;

        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        harness.append(
          record({
            type: "user",
            uuid: "u2",
            timestamp: "2026-09-18T10:00:03.000Z",
            message: {
              role: "user",
              content: [
                { type: "text", text: "[Image #1] what is this?" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
              ],
            },
          }),
        );
        yield* service.sweep;

        const message = (yield* harness.thread)?.messages.at(-1);
        expect(message?.text).toBe("[Image #1] what is this?");
        const attachment = message?.attachments?.[0];
        expect(attachment).toMatchObject({ type: "image", mimeType: "image/png", sizeBytes: 70 });
        expect(harness.storedAttachmentBytes(`${attachment?.id}.png`)).toBe(70);
        yield* service.close;
      }),
    );
  });

  it.effect("skips a session T3 Code runs itself, but mirrors one it only imported", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Owned by T3"));
        harness.setRoster({ status: "busy" });
        harness.setOwnedByT3("running");
        const service = yield* harness.startService;
        yield* service.sweep;
        expect(yield* harness.thread).toBeUndefined();

        harness.setOwnedByT3("stopped");
        yield* service.sweep;
        expect((yield* harness.thread)?.messages.map((message) => message.text)).toEqual([
          "Owned by T3",
        ]);
        yield* service.close;
      }),
    );
  });

  it.effect("does not repeat backfilled history or pre-attach tool calls after a restart", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        // More than the backfill cap, plus a finished tool call the import never carries.
        for (let index = 0; index < 250; index += 1) {
          harness.append(userRecord(`u${index}`, `Message ${index}`));
        }
        harness.append(
          assistantRecord("a-tool", [
            { type: "tool_use", id: "tool-old", name: "Bash", input: { command: "ls" } },
          ]),
        );
        harness.append(toolResultRecord("u-tool", "tool-old"));
        harness.setRoster({ status: "idle" });
        const first = yield* harness.startService;
        yield* first.sweep;
        yield* first.close;
        expect((yield* harness.thread)?.messages).toHaveLength(200);
        const beforeRestart = yield* harness.latestSequence;

        const second = yield* harness.startService;
        yield* second.sweep;
        expect(yield* harness.latestSequence).toBe(beforeRestart);
        expect((yield* harness.thread)?.activities).toEqual([]);
        yield* second.close;
      }),
    );
  });

  it.effect("keeps a running tool's title when it completes after a restart", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Go"));
        harness.setRoster({ status: "busy" });
        const first = yield* harness.startService;
        yield* first.sweep;
        harness.append(
          assistantRecord("a1", [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 60" } },
          ]),
        );
        yield* first.sweep;
        yield* first.close;

        harness.append(toolResultRecord("u2", "tool-1"));
        const second = yield* harness.startService;
        yield* second.sweep;
        expect(
          (yield* harness.thread)?.activities.map((activity) => [activity.kind, activity.summary]),
        ).toEqual([
          ["tool.updated", "Bash"],
          ["tool.completed", "Bash"],
        ]);
        yield* second.close;
      }),
    );
  });

  it.effect("does not duplicate or concatenate text when the transcript is rewritten", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Hi"));
        harness.append(assistantRecord("a1", [{ type: "text", text: "Hello" }]));
        harness.append(assistantRecord("a2", [{ type: "text", text: "A longer second reply" }]));
        harness.setRoster({ status: "idle" });
        const service = yield* harness.startService;
        yield* service.sweep;
        const beforeRewrite = yield* harness.latestSequence;

        harness.rewriteTranscript(
          userRecord("u1", "Hi") + assistantRecord("a1", [{ type: "text", text: "Hello" }]),
        );
        yield* service.sweep;
        expect(yield* harness.latestSequence).toBe(beforeRewrite);

        harness.append(assistantRecord("a3", [{ type: "text", text: "After the rewrite" }]));
        yield* service.sweep;
        expect((yield* harness.thread)?.messages.map((message) => message.text)).toEqual([
          "Hi",
          "Hello",
          "A longer second reply",
          "After the rewrite",
        ]);
        yield* service.close;
      }),
    );
  });

  it.effect(
    "keeps an archived mirror quiet across a restart and catches up when unarchived",
    () => {
      const harness = createHarness();
      return harness.run(
        Effect.gen(function* () {
          harness.append(userRecord("u1", "Before archive"));
          harness.setRoster({ status: "busy" });
          const first = yield* harness.startService;
          yield* first.sweep;
          yield* first.close;
          yield* harness.dispatchThreadCommand("thread.archive");
          const archivedAt = yield* harness.latestSequence;

          harness.append(assistantRecord("a1", [{ type: "text", text: "While archived" }]));
          const second = yield* harness.startService;
          yield* second.sweep;
          yield* second.sweep;
          expect(yield* harness.latestSequence).toBe(archivedAt);

          yield* harness.dispatchThreadCommand("thread.unarchive");
          yield* second.sweep;
          expect((yield* harness.thread)?.messages.map((message) => message.text)).toEqual([
            "Before archive",
            "While archived",
          ]);
          yield* second.close;
        }),
      );
    },
  );

  it.effect("keeps a deleted mirror deleted across a restart", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Doomed"));
        harness.setRoster({ status: "busy" });
        const first = yield* harness.startService;
        yield* first.sweep;
        yield* first.close;
        yield* harness.dispatchThreadCommand("thread.delete");
        const deletedAt = yield* harness.latestSequence;

        harness.append(assistantRecord("a1", [{ type: "text", text: "Still talking" }]));
        const second = yield* harness.startService;
        yield* second.sweep;
        expect(yield* harness.latestSequence).toBe(deletedAt);
        expect(yield* harness.thread).toBeUndefined();
        yield* second.close;
      }),
    );
  });

  it.effect("catches up on a backlog larger than one read window without gaps", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u0", "Start"));
        harness.setRoster({ status: "busy" });
        const first = yield* harness.startServiceWith({ readWindowBytes: 600 });
        yield* first.sweep;
        yield* first.close;

        const downtime = Array.from({ length: 12 }, (_, index) => `Downtime ${index}`);
        for (const [index, text] of downtime.entries()) {
          harness.append(
            userRecord(
              `d${index}`,
              text,
              `2026-09-18T10:01:${String(index).padStart(2, "0")}.000Z`,
            ),
          );
        }
        const second = yield* harness.startServiceWith({ readWindowBytes: 600 });
        for (let sweeps = 0; sweeps < 12; sweeps += 1) yield* second.sweep;
        expect((yield* harness.thread)?.messages.map((message) => message.text)).toEqual([
          "Start",
          ...downtime,
        ]);
        yield* second.close;
      }),
    );
  });

  it.effect("stops mirrored threads when the server restarts with the setting off", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Busy"));
        harness.setRoster({ status: "busy" });
        const first = yield* harness.startService;
        yield* first.sweep;
        yield* first.close;
        expect((yield* harness.shell)?.session?.status).toBe("running");

        yield* harness.setEnabled(false);
        const second = yield* harness.startService;
        yield* second.sweep;
        expect((yield* harness.shell)?.session?.status).toBe("stopped");
        yield* second.close;
      }),
    );
  });

  it.effect("does nothing while the setting is off", () => {
    const harness = createHarness({ enabled: false });
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Hidden"));
        harness.setRoster({ status: "busy" });
        const service = yield* harness.startService;
        yield* service.sweep;
        expect(yield* harness.thread).toBeUndefined();
        yield* service.close;
      }),
    );
  });

  it.effect("does not mirror claude-mem observer sessions", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.setRoster({ cwd: "/tmp/home/.claude-mem/observer-sessions/observer-1" });
        const service = yield* harness.startService;
        yield* service.sweep;
        expect(yield* harness.thread).toBeUndefined();
        yield* service.close;
      }),
    );
  });

  it.effect("settles a mirrored thread when its session leaves the roster", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Alive"));
        harness.setRoster({ status: "busy" });
        const service = yield* harness.startService;
        yield* service.sweep;
        expect((yield* harness.shell)?.session?.status).toBe("running");
        expect((yield* harness.shell)?.settledOverride).not.toBe("settled");

        // The session leaves the roster: its thread must drop out of the active list.
        harness.setRoster(null);
        yield* service.sweep;
        expect((yield* harness.shell)?.session?.status).toBe("stopped");
        expect((yield* harness.shell)?.settledOverride).toBe("settled");
        yield* service.close;
      }),
    );
  });

  it.effect("keeps a live session's thread in the active list across reconciles", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Alive"));
        harness.setRoster({ status: "busy" });
        const service = yield* harness.startService;
        // Repeated reconciles while the session stays live must not settle it.
        yield* service.sweep;
        yield* service.sweep;
        yield* service.sweep;
        expect((yield* harness.shell)?.settledOverride).not.toBe("settled");
        expect((yield* harness.shell)?.session?.status).toBe("running");
        yield* service.close;
      }),
    );
  });

  it.effect("does not resurrect a settled thread when its sessionId reappears", () => {
    const harness = createHarness();
    return harness.run(
      Effect.gen(function* () {
        harness.append(userRecord("u1", "Alive"));
        harness.setRoster({ status: "busy" });
        const service = yield* harness.startService;
        yield* service.sweep;
        harness.setRoster(null);
        yield* service.sweep;
        expect((yield* harness.shell)?.settledOverride).toBe("settled");

        // The sessionId reappears: ended-retention keeps the thread settled and
        // does not recreate or reactivate it, and it is not re-settled either.
        harness.setRoster({ status: "busy" });
        yield* service.sweep;
        const reappeared = yield* harness.shell;
        expect(reappeared).toBeDefined();
        expect(reappeared?.settledOverride).toBe("settled");
        yield* service.close;
      }),
    );
  });
});

describe("isClaudeMemObserverSession", () => {
  it("excludes sessions whose cwd sits inside a .claude-mem directory", () => {
    expect(isClaudeMemObserverSession("/home/pablo/.claude-mem/observer-sessions/abc123")).toBe(
      true,
    );
    expect(isClaudeMemObserverSession("/Users/x/.claude-mem/observer-sessions/y")).toBe(true);
  });

  it("includes normal worktree and project cwds", () => {
    expect(isClaudeMemObserverSession("/home/pablo/code/t3code/.worktrees/kanban-board")).toBe(
      false,
    );
    // A similarly named directory is not the claude-mem data dir.
    expect(isClaudeMemObserverSession("/home/pablo/claude-mem-notes")).toBe(false);
  });
});
