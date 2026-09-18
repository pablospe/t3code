import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(input: {
  readonly taskDetails?: string | null;
  readonly workflowPreset?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        taskDetails: input.taskDetails ?? null,
        workflowPreset: input.workflowPreset ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("board task meta decider", (it) => {
  it.effect("carries taskDetails and workflowPreset into the meta-updated payload", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-task-details"),
          threadId: ThreadId.make("thread-1"),
          taskDetails: "Ship the board",
          workflowPreset: "review",
        },
        readModel: makeReadModel({}),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.taskDetails).toBe("Ship the board");
        expect(event.payload.workflowPreset).toBe("review");
      }
    }),
  );

  it.effect("omits fields the command left untouched", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-task-details-partial"),
          threadId: ThreadId.make("thread-1"),
          taskDetails: "Ship the board",
        },
        readModel: makeReadModel({ workflowPreset: "review" }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.taskDetails).toBe("Ship the board");
        expect("workflowPreset" in event.payload).toBe(false);
      }
    }),
  );

  it.effect("passes null through so clients can clear the fields", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-task-details-clear"),
          threadId: ThreadId.make("thread-1"),
          taskDetails: null,
          workflowPreset: null,
        },
        readModel: makeReadModel({ taskDetails: "Ship the board", workflowPreset: "review" }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.taskDetails).toBeNull();
        expect(event.payload.workflowPreset).toBeNull();
      }
    }),
  );
});
