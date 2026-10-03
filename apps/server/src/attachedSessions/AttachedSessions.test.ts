// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, it } from "@effect/vitest";
import {
  ATTACHED_CLAUDE_INSTANCE_ID,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  attachedClaudeThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  AttachedMessageSendError,
  type AttachedSessionSendInput,
} from "./AttachedSessionSender.ts";
import * as AttachedSessions from "./AttachedSessions.ts";
import { ClaudeAgentsRoster, type ClaudeAgentsRosterEntry } from "./ClaudeAgentsRoster.ts";

const LIVE = "11111111-1111-4111-8111-111111111111";
const T3_OWNED = "22222222-2222-4222-8222-222222222222";
const LEGACY = "33333333-3333-4333-8333-333333333333";
const OBSERVER = "44444444-4444-4444-8444-444444444444";
const projectId = ProjectId.make("project:attached");

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attached-sessions-"));
const workspace = NodePath.join(root, "workspace");
const stateBase = NodePath.join(root, "t3");
const configDir = NodePath.join(root, "claude");
const transcriptDir = NodePath.join(configDir, "projects", "-workspace");
NodeFS.mkdirSync(workspace, { recursive: true });
NodeFS.mkdirSync(transcriptDir, { recursive: true });

afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const transcriptPath = (sessionId: string) => NodePath.join(transcriptDir, `${sessionId}.jsonl`);
const appendTranscript = (sessionId: string, ...records: ReadonlyArray<unknown>) =>
  NodeFS.appendFileSync(
    transcriptPath(sessionId),
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
const userText = (uuid: string, text: string) => ({
  type: "user",
  uuid,
  timestamp: "2026-10-03T10:00:00.000Z",
  message: { content: text },
});
const assistant = (uuid: string, content: ReadonlyArray<unknown>) => ({
  type: "assistant",
  uuid,
  timestamp: "2026-10-03T10:00:01.000Z",
  gitBranch: "main",
  message: { model: "claude-opus-4-1", content },
});
const toolResult = (uuid: string, toolUseId: string) => ({
  type: "user",
  uuid,
  timestamp: "2026-10-03T10:00:02.000Z",
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
});
const rosterEntry = (
  sessionId: string,
  status: ClaudeAgentsRosterEntry["status"],
  cwd = workspace,
  waitingFor: string | null = null,
): ClaudeAgentsRosterEntry => ({
  sessionId,
  cwd,
  name: `session-${sessionId.slice(0, 4)}`,
  status,
  waitingFor,
  startedAt: null,
});

const database = SqlitePersistenceMemory;
const makeTestLayer = (input: {
  readonly roster: Ref.Ref<ReadonlyArray<ClaudeAgentsRosterEntry>>;
  readonly sends: Ref.Ref<ReadonlyArray<AttachedSessionSendInput>>;
  readonly legacyImports: Ref.Ref<ReadonlyArray<ThreadId>>;
}) => {
  const orchestration = Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "attached-sessions" },
      ProviderAdapterRegistry.makeLayer([]),
      {
        databaseLayer: database,
        runEffectWorker: false,
        attachedSessionDeliver: (send) =>
          Ref.update(input.sends, (sends) => [...sends, send]).pipe(
            Effect.andThen(
              send.text === "unreachable"
                ? Effect.fail(
                    new AttachedMessageSendError({
                      sessionId: send.sessionId,
                      detail: "The terminal session is no longer running.",
                    }),
                  )
                : Effect.void,
            ),
          ),
      },
    ),
  );
  return AttachedSessions.makeLayer({ rosterIntervalMs: 60_000, tailIntervalMs: 60_000 }).pipe(
    Layer.provideMerge(orchestration),
    Layer.provideMerge(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.succeed(ClaudeAgentsRoster, {
          snapshot: Ref.get(input.roster).pipe(
            Effect.map((sessions) => Option.some({ sessions, configDir })),
          ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: (workspaceRoot) =>
            Effect.succeed(
              workspaceRoot === workspace
                ? Option.some({ id: projectId, workspaceRoot } as never)
                : Option.none(),
            ),
          listShells: () => Effect.succeed([]),
        }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          ensureTranscript: (threadId) =>
            Ref.update(input.legacyImports, (ids) => [...ids, threadId]).pipe(
              Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
            ),
        }),
        ServerSettings.layerTest({ enableAttachedSessions: true }),
        ServerConfig.layerTest(workspace, stateBase),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

const projectionOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.getThreadProjection(threadId);
  });
const activityStatus = (projection: OrchestrationV2ThreadProjection) =>
  projection.thread.externalSession?.activity?.status;
const timeline = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((item) =>
      item.type === "user_message" || item.type === "assistant_message"
        ? `${item.type}:${item.text}`
        : `${item.type}:${item.status}`,
    );

it.effect("mirrors a terminal session, keeps T3 control off it, and relays messages to it", () => {
  appendTranscript(
    LIVE,
    userText("u1", "hello"),
    assistant("a1", [{ type: "text", text: "hi there" }]),
  );
  appendTranscript(T3_OWNED, userText("t1", "owned"));
  return Effect.gen(function* () {
    const roster = yield* Ref.make<ReadonlyArray<ClaudeAgentsRosterEntry>>([]);
    const sends = yield* Ref.make<ReadonlyArray<AttachedSessionSendInput>>([]);
    const legacyImports = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    yield* Effect.gen(function* () {
      const mirror = yield* AttachedSessions.AttachedSessions;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sweep = (kind: "roster" | "tail") =>
        mirror.sweep(kind).pipe(Effect.andThen(mirror.drain));
      const threadId = attachedClaudeThreadId(LIVE);
      const now = yield* DateTime.now;

      // A session T3 already drives has a provider thread derived from its id.
      const t3ThreadId = ThreadId.make("thread:t3-owned");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:t3-owned:thread"),
            type: "thread.created",
            threadId: t3ThreadId,
            occurredAt: now,
            payload: {
              ...fixtureThread(t3ThreadId, now),
            },
          },
          {
            id: EventId.make("event:t3-owned:provider-thread"),
            type: "provider-thread.updated",
            threadId: t3ThreadId,
            occurredAt: now,
            payload: {
              id: IdAllocator.deriveProviderThread({
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeThreadId: T3_OWNED,
              }),
              driver: ProviderDriverKind.make("claudeAgent"),
              providerInstanceId: ATTACHED_CLAUDE_INSTANCE_ID,
              providerSessionId: null,
              appThreadId: t3ThreadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });

      yield* Ref.set(roster, [
        rosterEntry(LIVE, "busy"),
        rosterEntry(T3_OWNED, "busy"),
        rosterEntry(OBSERVER, "busy", NodePath.join(root, ".claude-mem", "observer-sessions")),
      ]);
      yield* sweep("roster");

      let projection = yield* projectionOf(threadId);
      assert.deepInclude(projection.thread.externalSession, {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeSessionId: LIVE,
      });
      assert.equal(projection.thread.projectId, projectId);
      assert.equal(projection.thread.branch, "main");
      assert.deepEqual(timeline(projection), ["user_message:hello", "assistant_message:hi there"]);
      assert.equal(activityStatus(projection), "running");
      // The session's lifetime, not inactivity, takes the thread off the active list.
      assert.isNotNull(projection.thread.autoSettleDisabledAt ?? null);
      // The sidebar reads the session's activity from the thread shell.
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.equal(shell?.externalSession?.activity?.status, "running");
      for (const skipped of [T3_OWNED, OBSERVER]) {
        const missing = yield* Effect.option(projectionOf(attachedClaudeThreadId(skipped)));
        assert.isTrue(Option.isNone(missing), `${skipped} must not be mirrored`);
      }

      // Live tail: a tool starts, then finishes.
      appendTranscript(
        LIVE,
        assistant("a2", [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ]),
      );
      yield* sweep("tail");
      projection = yield* projectionOf(threadId);
      assert.include(timeline(projection), "command_execution:running");
      appendTranscript(LIVE, toolResult("u2", "tool-1"));
      yield* sweep("tail");
      projection = yield* projectionOf(threadId);
      assert.deepEqual(timeline(projection), [
        "user_message:hello",
        "assistant_message:hi there",
        "command_execution:completed",
      ]);

      // T3 cannot start, steer, reconfigure or fork the terminal's conversation.
      const refusals = [
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:attached:dispatch"),
          threadId,
          messageId: MessageId.make("message:attached:dispatch"),
          text: "go",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        }),
        orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("command:attached:model"),
          threadId,
          modelSelection: { instanceId: ATTACHED_CLAUDE_INSTANCE_ID, model: "other" },
        }),
        orchestrator.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:attached:fork"),
          sourceThreadId: threadId,
          targetThreadId: ThreadId.make("thread:attached-fork"),
          sourcePoint: { type: "latest_stable" },
        }),
      ];
      for (const refusal of refusals) {
        const error = yield* Effect.flip(refusal);
        assert.equal(error._tag, "OrchestratorExternalSessionThreadReadOnlyError");
      }

      // Messages typed in T3 go to the terminal session through the relay.
      yield* orchestrator.dispatch({
        type: "thread.external-session.message.send",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:attached:send"),
        threadId,
        text: "ship it",
      });
      yield* orchestrator.dispatch({
        type: "thread.external-session.message.send",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:attached:send-failed"),
        threadId,
        text: "unreachable",
      });
      yield* worker.drain();
      assert.deepEqual(yield* Ref.get(sends), [
        { sessionId: LIVE, text: "ship it" },
        { sessionId: LIVE, text: "unreachable" },
      ]);
      projection = yield* projectionOf(threadId);
      const notice = projection.turnItems.find((item) => item.type === "system_notice");
      assert.include(
        notice?.type === "system_notice" ? notice.message : "",
        "The terminal session is no longer running.",
      );

      // An ordinary thread does not take external-session messages.
      const rejected = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.external-session.message.send",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:t3-owned:send"),
          threadId: t3ThreadId,
          text: "hello",
        }),
      );
      assert.equal(rejected._tag, "OrchestratorDispatchError");

      // The session exits: the root turn ends and the thread leaves the active list.
      yield* Ref.set(roster, []);
      yield* sweep("roster");
      projection = yield* projectionOf(threadId);
      assert.equal(activityStatus(projection), "ended");
      assert.equal(projection.thread.settledOverride, "settled");

      // Resumed in the terminal and stopped at a prompt: back on the active list, with the reason.
      yield* Ref.set(roster, [rosterEntry(LIVE, "waiting", workspace, "permission prompt")]);
      yield* sweep("roster");
      projection = yield* projectionOf(threadId);
      assert.equal(projection.thread.settledOverride, "active");
      assert.deepInclude(projection.thread.externalSession?.activity, {
        status: "waiting",
        waitingReason: "permission prompt",
      });
      assert.deepEqual(yield* Ref.get(legacyImports), []);
    }).pipe(Effect.provide(makeTestLayer({ roster, sends, legacyImports })));
  });
});

it.effect("adopts a thread the V1 mirror created instead of duplicating it", () => {
  appendTranscript(LEGACY, userText("l1", "from before the upgrade"));
  const offset = NodeFS.statSync(transcriptPath(LEGACY)).size;
  return Effect.gen(function* () {
    const roster = yield* Ref.make<ReadonlyArray<ClaudeAgentsRosterEntry>>([
      rosterEntry(LEGACY, "waiting"),
    ]);
    const sends = yield* Ref.make<ReadonlyArray<AttachedSessionSendInput>>([]);
    const legacyImports = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    yield* Effect.gen(function* () {
      const mirror = yield* AttachedSessions.AttachedSessions;
      const eventSink = yield* EventSink.EventSinkV2;
      const config = yield* ServerConfig.ServerConfig;
      const threadId = attachedClaudeThreadId(LEGACY);
      const now = yield* DateTime.now;
      // What LegacyV1ThreadImporter leaves behind for a V1 attached thread.
      const legacyThread: OrchestrationV2AppThread = {
        ...fixtureThread(threadId, now),
        historyOrigin: "v1_import",
      };
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy:thread"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: legacyThread,
          },
        ],
      });
      writeLegacyCursor(config.stateDir, offset);

      yield* mirror.sweep("roster").pipe(Effect.andThen(mirror.drain));
      let projection = yield* projectionOf(threadId);
      assert.equal(projection.thread.externalSession?.nativeSessionId, LEGACY);
      assert.isNotNull(projection.thread.autoSettleDisabledAt ?? null);
      assert.equal(activityStatus(projection), "waiting");
      assert.deepEqual(timeline(projection), []);

      appendTranscript(LEGACY, assistant("l2", [{ type: "text", text: "after the upgrade" }]));
      yield* mirror.sweep("tail").pipe(Effect.andThen(mirror.drain));
      projection = yield* projectionOf(threadId);
      assert.deepEqual(timeline(projection), ["assistant_message:after the upgrade"]);
      // Its V1 history is put in place before anything is added after it.
      assert.deepEqual(yield* Ref.get(legacyImports), [threadId]);
    }).pipe(Effect.provide(makeTestLayer({ roster, sends, legacyImports })));
  });
});

/** The V1 mirror's cursor for LEGACY, already covering `offset` bytes of its transcript. */
function writeLegacyCursor(stateDir: string, offset: number) {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "attached-sessions.json"),
    JSON.stringify({
      sessions: {
        [LEGACY]: {
          transcriptPath: transcriptPath(LEGACY),
          offset,
          status: "running",
          waitRequestId: null,
          toolCalls: {},
          endedAt: null,
        },
      },
    }),
  );
}

/** A plain thread record to build fixtures from. */
function fixtureThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId,
    title: "fixture",
    providerInstanceId: ATTACHED_CLAUDE_INSTANCE_ID,
    modelSelection: { instanceId: ATTACHED_CLAUDE_INSTANCE_ID, model: "claude" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}
