import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ATTACHED_CLAUDE_INSTANCE_ID,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  attachedClaudeThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-18T10:00:00.000Z";
const threadId = attachedClaudeThreadId("session-1");

const attachedReadModel = projectEvent(createEmptyReadModel(createdAt), {
  sequence: 1,
  eventId: EventId.make("event-attached-thread-created"),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.created",
  occurredAt: createdAt,
  commandId: CommandId.make("command-attached-thread-created"),
  causationEventId: null,
  correlationId: CommandId.make("command-attached-thread-created"),
  metadata: {},
  payload: {
    threadId,
    projectId: ProjectId.make("project-1"),
    title: "Attached",
    modelSelection: { instanceId: ATTACHED_CLAUDE_INSTANCE_ID, model: "claude" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
    updatedAt: createdAt,
  },
});

it.layer(NodeServices.layer)("attached session threads", (it) => {
  it.effect("rejects a turn start from a client", () =>
    Effect.gen(function* () {
      const readModel = yield* attachedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("command-attached-turn-start"),
            threadId,
            message: {
              messageId: MessageId.make("message-1"),
              role: "user",
              text: "Do work",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          },
          readModel,
        }),
      );

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("read-only");
    }),
  );

  it.effect("rejects stopping the session", () =>
    Effect.gen(function* () {
      const readModel = yield* attachedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.stop",
            commandId: CommandId.make("command-attached-session-stop"),
            threadId,
            createdAt,
          },
          readModel,
        }),
      );

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects moving the thread to a real provider, but allows a rename", () =>
    Effect.gen(function* () {
      const readModel = yield* attachedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("command-attached-model"),
            threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
          },
          readModel,
        }),
      );
      const modeError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("command-attached-runtime-mode"),
            threadId,
            runtimeMode: "approval-required",
            createdAt,
          },
          readModel,
        }),
      );
      const renamed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("command-attached-rename"),
          threadId,
          title: "Renamed",
        },
        readModel,
      });

      expect(error.message).toContain("read-only");
      expect(modeError.message).toContain("read-only");
      expect([renamed].flat()[0]?.type).toBe("thread.meta-updated");
    }),
  );

  it.effect("still accepts mirrored content and archiving", () =>
    Effect.gen(function* () {
      const readModel = yield* attachedReadModel;
      const appended = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.user.append",
          commandId: CommandId.make("command-attached-user-append"),
          threadId,
          message: {
            messageId: MessageId.make("attached:session-1:uuid-1"),
            text: "From the terminal",
            attachments: [],
          },
          createdAt,
        },
        readModel,
      });
      const archived = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("command-attached-archive"),
          threadId,
        },
        readModel,
      });

      expect([appended].flat()[0]?.type).toBe("thread.message-sent");
      expect([archived].flat()[0]?.type).toBe("thread.archived");
    }),
  );
});
