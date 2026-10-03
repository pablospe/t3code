/**
 * Where each attached session's mirror has read up to, kept on disk.
 *
 * The transcript is only ever read forward from this cursor, so a server
 * restart does not replay history into the timeline. The cursor also remembers
 * sessions whose thread was archived or deleted, so they are not recreated. The
 * file format predates Orchestrator V2, which lets the V2 mirror carry on
 * where the V1 mirror stopped.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AttachedSessionCursor = Schema.Struct({
  transcriptPath: Schema.NullOr(Schema.String),
  offset: Schema.Finite,
  /** The last root-turn status that was written. Files from before Orchestrator V2
      hold a V1 session status here, which reads as unknown and is written again. */
  status: Schema.NullOr(Schema.String),
  /** When the current stretch of work began. */
  workStartedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Tools that started but have not completed, so their result row keeps its title and place. */
  toolCalls: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.String,
      detail: Schema.NullOr(Schema.String),
      ordinal: Schema.optionalKey(Schema.Finite),
    }),
  ),
  endedAt: Schema.NullOr(Schema.String),
  /** The thread was settled out of the active list because its session left the
      roster. Persisted so a restart does not re-settle the whole stale backlog.
      Optional so cursor files written before this field still decode. */
  settled: Schema.optionalKey(Schema.Boolean),
});
type AttachedSessionCursor = typeof AttachedSessionCursor.Type;

// Entries are validated one by one on load. Losing every cursor to one bad
// entry would recreate the mirrors of threads the user deleted.
const AttachedSessionCursorFile = Schema.Struct({
  sessions: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeCursorFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(AttachedSessionCursorFile),
);
const decodeCursor = Schema.decodeUnknownOption(AttachedSessionCursor);
const encodeCursorFile = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ sessions: Schema.Record(Schema.String, AttachedSessionCursor) }),
  ),
);

// Ended sessions are kept so a deleted thread stays deleted, but not forever.
const ENDED_CURSOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A missing or unreadable file is an empty store; the mirror then starts at the end of each transcript. */
export const loadAttachedSessionCursors = (filePath: string, nowMs: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const sessions = Option.getOrUndefined(decodeCursorFile(text))?.sessions ?? {};
    return new Map(
      Object.entries(sessions).flatMap(([sessionId, value]) => {
        const cursor = Option.getOrUndefined(decodeCursor(value));
        return cursor !== undefined &&
          (cursor.endedAt === null || nowMs - Date.parse(cursor.endedAt) < ENDED_CURSOR_MAX_AGE_MS)
          ? [[sessionId, cursor] as const]
          : [];
      }),
    );
  });

export const saveAttachedSessionCursors = (
  filePath: string,
  cursors: ReadonlyMap<string, AttachedSessionCursor>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const temporaryPath = `${filePath}.tmp`;
    yield* fileSystem.writeFileString(
      temporaryPath,
      encodeCursorFile({ sessions: Object.fromEntries(cursors) }),
    );
    yield* fileSystem.rename(temporaryPath, filePath);
  });
