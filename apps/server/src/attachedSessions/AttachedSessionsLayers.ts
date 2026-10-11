/**
 * The attached-session layers, assembled here so the server's runtime wiring
 * adds each with one entry and only supplies its event sink.
 */
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AttachedSessionSender from "./AttachedSessionSender.ts";
import * as AttachedSessions from "./AttachedSessions.ts";
import * as ClaudeAgentsRoster from "./ClaudeAgentsRoster.ts";

const layerClaudeAgentsRoster = ClaudeAgentsRoster.layer.pipe(Layer.provide(ProcessRunner.layer));

/** The effect worker's sender for `external-session.message.send`. */
export const layerSender = AttachedSessionSender.layer.pipe(
  Layer.provide(Layer.mergeAll(IdAllocator.layer, ProjectionStore.layer, layerClaudeAgentsRoster)),
);

/** Stands in for the Agent SDK relay behind external-session message sends. */
export type ReplayDeliver = AttachedSessionSender.AttachedSessionDeliver;

/** Replays stand a stub in for the Agent SDK relay; one that sends unexpectedly dies. */
export const layerSenderForReplay = (deliver?: ReplayDeliver) =>
  AttachedSessionSender.layerWithDeliver(
    deliver ?? (() => Effect.die("This replay does not expect an external-session send.")),
  ).pipe(Layer.provide(IdAllocator.layer));

/**
 * Mirrors Claude CLI sessions running in a terminal while
 * `enableAttachedSessions` is on. Starts polling with the server.
 */
export const layerDaemon = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* AttachedSessions.AttachedSessions;
    yield* service.start();
  }),
).pipe(
  Layer.provide(AttachedSessions.layer),
  Layer.provide(Layer.mergeAll(ProjectionStore.layer, IdAllocator.layer, layerClaudeAgentsRoster)),
);
