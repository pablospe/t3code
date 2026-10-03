import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Task fields never start a provider"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "task-details" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("thread.metadata.update sets, keeps and clears board task fields", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:task-details");
    // Both shell read paths: the single-thread shell and the snapshot rows.
    const readTaskFields = Effect.gen(function* () {
      const thread = yield* projections.getThread(threadId);
      const shell = yield* projections.getThreadShell(threadId);
      const snapshot = yield* projections.getShellSnapshot({ location: "active" });
      const row = snapshot.threads.find((candidate) => candidate.id === threadId);
      return [thread, shell, row].map((source) => ({
        taskDetails: source?.taskDetails ?? null,
        workflowPreset: source?.workflowPreset ?? null,
      }));
    });
    const expectEverywhere = (expected: {
      taskDetails: string | null;
      workflowPreset: string | null;
    }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* readTaskFields, [expected, expected, expected]);
      });

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:task-details"),
      title: "Ship the board",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* expectEverywhere({ taskDetails: null, workflowPreset: null });

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("set-task"),
      threadId,
      taskDetails: "Cards dropped on Planning send the full brief.",
      workflowPreset: "openspec",
    });
    yield* expectEverywhere({
      taskDetails: "Cards dropped on Planning send the full brief.",
      workflowPreset: "openspec",
    });

    // Absent fields leave the task alone, and one field can change alone.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename"),
      threadId,
      title: "Ship the board, V2",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("switch-preset"),
      threadId,
      workflowPreset: "review",
    });
    yield* expectEverywhere({
      taskDetails: "Cards dropped on Planning send the full brief.",
      workflowPreset: "review",
    });

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("clear-task"),
      threadId,
      taskDetails: null,
      workflowPreset: null,
    });
    yield* expectEverywhere({ taskDetails: null, workflowPreset: null });
  }).pipe(Effect.provide(testLayer)),
);
