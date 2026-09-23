// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ATTACHED_CLAUDE_INSTANCE_ID,
  CommandId,
  ProjectId,
  attachedClaudeThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "../orchestration/Layers/RuntimeReceiptBus.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../orchestration/Services/RuntimeReceiptBus.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  AttachedMessageSendError,
  AttachedSessionSender,
  type AttachedSessionDeliver,
  type AttachedSessionSendInput,
  interpretRelayTranscript,
  makeLayer,
  resolveRosterRecipient,
} from "./AttachedSessionSender.ts";
import { ClaudeAgentsRoster } from "./ClaudeAgentsRoster.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const threadId = attachedClaudeThreadId(SESSION_ID);
const projectId = ProjectId.make("project-attached-sender");
const createdAt = "2026-09-18T10:00:00.000Z";

function makeHarness(deliver: AttachedSessionDeliver) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attached-sender-"));
  const cwd = NodePath.join(root, "workspace");
  NodeFS.mkdirSync(cwd, { recursive: true });

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const baseLayer = Layer.empty.pipe(
    Layer.provideMerge(makeLayer({ deliver })),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(cwd, root)),
    Layer.provideMerge(NodeServices.layer),
    // The default deliver resolves the recipient via the roster; these tests stub
    // `deliver`, so a never-snapshot roster is enough to satisfy the layer.
    Layer.provideMerge(Layer.succeed(ClaudeAgentsRoster, { snapshot: Effect.succeedNone })),
  );

  /**
   * Starts the sender, seeds an attached thread, dispatches the send, and
   * returns the first settle receipt. Waiting on the receipt (not a sleep) is
   * how the async send is observed.
   */
  const runSend = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const engine = yield* OrchestrationEngineService;
    const sender = yield* AttachedSessionSender;
    const receiptBus = yield* RuntimeReceiptBus;
    const receipts = yield* Queue.unbounded<OrchestrationRuntimeReceipt>();
    yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
      Queue.offer(receipts, receipt),
    ).pipe(Effect.forkIn(scope, { startImmediately: true }));
    yield* sender.start().pipe(Scope.provide(scope));

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId,
      title: "workspace",
      workspaceRoot: cwd,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId,
      projectId,
      title: "⌁ terminal session",
      modelSelection: { instanceId: ATTACHED_CLAUDE_INSTANCE_ID, model: "claude" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.attached.message.send",
      commandId: CommandId.make("cmd-attached-send"),
      threadId,
      text: "ship it",
      createdAt,
    });

    const receipt = yield* Queue.take(receipts);
    yield* Scope.close(scope, Exit.void);
    return receipt;
  });

  return {
    runSend: runSend.pipe(
      Effect.provide(baseLayer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    ),
  };
}

describe("AttachedSessionSender", () => {
  it.effect("parses the session id, invokes the send boundary, and reports delivery", () => {
    const calls: Array<AttachedSessionSendInput> = [];
    const deliver: AttachedSessionDeliver = (input) =>
      Effect.sync(() => {
        calls.push(input);
      });
    return makeHarness(deliver).runSend.pipe(
      Effect.map((receipt) => {
        expect(calls).toEqual([{ sessionId: SESSION_ID, text: "ship it" }]);
        expect(receipt).toMatchObject({
          type: "attached.message.send.settled",
          threadId,
          sessionId: SESSION_ID,
          outcome: "delivered",
        });
      }),
    );
  });

  it.effect("reports a failed delivery honestly with the failure detail", () => {
    const deliver: AttachedSessionDeliver = (input) =>
      Effect.fail(
        new AttachedMessageSendError({
          sessionId: input.sessionId,
          detail: "held by recipient",
        }),
      );
    return makeHarness(deliver).runSend.pipe(
      Effect.map((receipt) => {
        expect(receipt).toMatchObject({
          type: "attached.message.send.settled",
          threadId,
          sessionId: SESSION_ID,
          outcome: "failed",
          detail: "held by recipient",
        });
      }),
    );
  });
});

// Minimal SDK-message shapes the relay produces, for the stream interpreter.
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (toolUseId: string, content: unknown, isError = false) => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  },
});
const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

describe("interpretRelayTranscript", () => {
  it("reports delivered when SendMessage ran and its result succeeded", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_list", "ListAgents"),
        toolResult("tu_list", "[{ sessionId, name }]"),
        toolUse("tu_send", "SendMessage", { to: "browser-recipient-a1", message: "hi" }),
        toolResult("tu_send", "Message delivered."),
        assistantText("RELAY_RESULT: SENT"),
        { type: "result", subtype: "success" },
      ],
      SESSION_ID,
    );
    expect(outcome).toEqual({
      delivered: true,
      detail: "relay confirmed SENT",
      to: "browser-recipient-a1",
    });
  });

  it("does not mistake the ListAgents result for the SendMessage result", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_list", "ListAgents"),
        toolResult("tu_list", "sessions..."),
        assistantText("done"),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("never called SendMessage");
    expect(outcome.to).toBeNull();
  });

  it("fails when SendMessage returns an error result", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult("tu_send", "no such session", true),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("SendMessage failed");
    expect(outcome.to).toBe("x");
  });

  it("treats a same-machine success carrying 'queued there' boilerplate as delivered", () => {
    // The real success payload: success:true plus forward-looking conditional
    // boilerplate ("queued there — a [Cross-session delivery notice] follows if
    // that session holds it … or refuses it"). That is not a hold.
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "uds-probe-sess-34" }),
        toolResult(
          "tu_send",
          '{"success":true,"message":"“nonce-7f3a” → uds-probe-sess-34 (another Claude session on this machine; queued there — a [Cross-session delivery notice] follows if that session holds it (different permission mode: its user must approve first) or refuses it)","msg_id":"m_123"}',
        ),
      ],
      "uds-probe-sess-34",
    );
    expect(outcome.delivered).toBe(true);
    expect(outcome.to).toBe("uds-probe-sess-34");
  });

  it("fails when the SendMessage result reports success:false", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult("tu_send", '{"success":false,"message":"unknown recipient"}'),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("SendMessage failed");
  });

  it("treats an explicit past-tense hold notice as not delivered", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult(
          "tu_send",
          '{"success":true,"message":"[Cross-session delivery notice] your message was held by the recipient (awaiting approval)"}',
        ),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("held by the recipient");
  });

  it("honors an explicit RELAY_RESULT: FAILED marker over a completed run", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult("tu_send", "ok"),
        assistantText("RELAY_RESULT: FAILED: session not found"),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("session not found");
  });

  it("fails when the SendMessage result is never observed", () => {
    const outcome = interpretRelayTranscript(
      [toolUse("tu_send", "SendMessage", { to: "x" })],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("no observable result");
  });
});

describe("resolveRosterRecipient", () => {
  const snapshotOf = (
    sessions: ReadonlyArray<{ readonly sessionId: string; readonly name: string | null }>,
  ) => Option.some({ sessions });

  it("resolves a running sessionId to its current name", () => {
    const result = resolveRosterRecipient(
      snapshotOf([
        { sessionId: "other", name: "peer-one" },
        { sessionId: SESSION_ID, name: "uds-probe-sess-34" },
      ]),
      SESSION_ID,
    );
    expect(result).toEqual({ kind: "found", name: "uds-probe-sess-34" });
  });

  it("fails fast when the sessionId is not in the roster", () => {
    const result = resolveRosterRecipient(
      snapshotOf([{ sessionId: "other", name: "peer-one" }]),
      SESSION_ID,
    );
    expect(result).toEqual({
      kind: "error",
      detail: "The terminal session is no longer running.",
    });
  });

  it("fails when the roster probe returned nothing", () => {
    expect(resolveRosterRecipient(Option.none(), SESSION_ID).kind).toBe("error");
  });

  it("fails when the running session has no addressable name", () => {
    const result = resolveRosterRecipient(
      snapshotOf([{ sessionId: SESSION_ID, name: null }]),
      SESSION_ID,
    );
    expect(result).toEqual({
      kind: "error",
      detail: "The terminal session has no addressable name.",
    });
  });
});
