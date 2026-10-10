// Delivers a real message to a running Claude CLI session through the whole
// send path: the command, the outbox effect, the roster lookup and the Agent
// SDK relay. Start a throwaway interactive session yourself, never one you
// work in, then run with
//   T3_ATTACHED_SESSION_LIVE_ID=<its session id> vp test run <this file>
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  attachedClaudeThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { attachedThread } from "./AttachedSessionMapper.ts";
import { makeAgentSdkDeliver } from "./AttachedSessionSender.ts";
import * as ClaudeAgentsRoster from "./ClaudeAgentsRoster.ts";

const sessionId = process.env.T3_ATTACHED_SESSION_LIVE_ID;

describe.runIf(sessionId !== undefined)("AttachedSessionSender live relay", () => {
  it.live(
    "hands a message typed in T3 to the terminal session",
    () =>
      Effect.gen(function* () {
        const nonce = `T3-LIVE-${(yield* DateTime.now).epochMilliseconds}`;
        const deliver = yield* makeAgentSdkDeliver.pipe(
          Effect.provide(
            ClaudeAgentsRoster.layer.pipe(
              Layer.provide(ProcessRunner.layer),
              Layer.provideMerge(ServerSettings.layerTest()),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = attachedClaudeThreadId(sessionId!);
          const thread = attachedThread({
            sessionId: sessionId!,
            threadId,
            projectId: ProjectId.make("project:attached-live"),
            title: "⌁ live relay",
            model: null,
            branch: null,
            worktreePath: null,
            now: DateTime.formatIso(yield* DateTime.now),
          });
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:attached-live:thread"),
                type: "thread.created",
                threadId,
                occurredAt: thread.createdAt,
                payload: thread,
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "thread.external-session.message.send",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:attached-live:${nonce}`),
            threadId,
            text: `Reply with exactly this word and nothing else: ${nonce}`,
          });
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const notice = projection.turnItems.find((item) => item.type === "system_notice");
          assert.isUndefined(
            notice,
            notice?.type === "system_notice" ? notice.message : "unexpected notice",
          );
          assert.equal(thread.externalSession?.driver, ProviderDriverKind.make("claudeAgent"));
          yield* Effect.logInfo(`attached-sessions live relay delivered ${nonce}`);
        }).pipe(
          Effect.provide(
            layerWithRegistry(
              { name: "attached-sessions-live" },
              ProviderAdapterRegistry.layerFromAdapters([]),
              { runEffectWorker: false, attachedSessionDeliver: deliver },
            ),
          ),
        );
      }),
    { timeout: 120_000 },
  );
});
