/**
 * Projection reads and shell fields for threads that mirror a session running
 * outside T3. Kept out of ProjectionStore.ts so it only spreads
 * `externalSessionShellFields` into its two shell builders.
 */
import {
  ThreadId,
  type OrchestrationV2AppThread,
  type ProviderDriverKind,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The shell carries the marker so lists can show the session's activity. */
export const externalSessionShellFields = (
  thread: Pick<OrchestrationV2AppThread, "externalSession">,
) => (thread.externalSession == null ? {} : { externalSession: thread.externalSession });

export class ExternalSessionOwnershipError extends Schema.TaggedError<ExternalSessionOwnershipError>()(
  "ExternalSessionOwnershipError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Failed to look up which thread owns a native session.";
  }
}

export class ExternalSessionOwnership extends Context.Service<
  ExternalSessionOwnership,
  {
    /**
     * The app thread whose provider thread runs this native thread (a Claude
     * session id, for example), if any. Matches the id derived from the native
     * id and the native ref a run records once it learns the id, since a run's
     * provider thread keeps the id it was given while still pending. Reads the
     * provider-thread projection; the JSON match scans, so callers check once
     * per session.
     */
    readonly getNativeThreadOwner: (input: {
      readonly driver: ProviderDriverKind;
      readonly nativeThreadId: string;
      readonly derivedProviderThreadId: ProviderThreadId;
    }) => Effect.Effect<ThreadId | null, ExternalSessionOwnershipError>;
  }
>()("t3/attachedSessions/ExternalSessionProjection/ExternalSessionOwnership") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ExternalSessionOwnership.of({
    getNativeThreadOwner: (input) =>
      sql<{ thread_id: string }>`SELECT thread_id
        FROM orchestration_v2_projection_provider_threads
        WHERE provider_thread_id = ${input.derivedProviderThreadId}
          OR (driver = ${input.driver}
            AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${input.nativeThreadId})
        LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id))),
        Effect.mapError((cause) => new ExternalSessionOwnershipError({ cause })),
      ),
  });
});

export const layer = Layer.effect(ExternalSessionOwnership, make);
