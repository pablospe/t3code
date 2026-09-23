/**
 * Reads the conversation out of a Claude CLI transcript line.
 *
 * The transcript format is undocumented and changes between CLI versions, so
 * everything here is best-effort: a line that does not decode is dropped, and
 * only `user` and `assistant` records are read. The rest of the file is CLI
 * bookkeeping.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  tool_use_id: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  source: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      media_type: Schema.optional(Schema.String),
      data: Schema.optional(Schema.String),
    }),
  ),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  uuid: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentBlock)])),
    }),
  ),
});

const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));

const MAX_TOOL_DETAIL_CHARS = 400;

/**
 * A message injected into a session from another session — including one T3
 * sends on the user's behalf — is recorded in the target transcript wrapped in a
 * `<cross-session-message from="uds:…" from-name="…" from-mode="…">` tag. Strip
 * the wrapper so the mirrored message shows the clean text the sender typed.
 */
const CROSS_SESSION_MESSAGE_OPEN = /^<cross-session-message\b[^>]*>/;
const CROSS_SESSION_MESSAGE_CLOSE = /<\/cross-session-message>$/;

function stripCrossSessionEnvelope(text: string): string {
  const withoutOpen = text.replace(CROSS_SESSION_MESSAGE_OPEN, "");
  if (withoutOpen === text) return text;
  return withoutOpen.replace(CROSS_SESSION_MESSAGE_CLOSE, "").trim();
}

/** An image pasted into the terminal prompt, still base64 encoded. */
export interface AttachedTranscriptImage {
  readonly mediaType: string;
  readonly base64: string;
}

export type AttachedTranscriptEntry =
  | {
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly uuid: string;
      readonly text: string;
      readonly images: ReadonlyArray<AttachedTranscriptImage>;
      readonly createdAt: string;
    }
  | {
      readonly kind: "tool-started";
      readonly toolUseId: string;
      readonly name: string;
      readonly detail: string | null;
      readonly createdAt: string;
    }
  | {
      readonly kind: "tool-completed";
      readonly toolUseId: string;
      readonly failed: boolean;
      readonly createdAt: string;
    };

export interface AttachedTranscriptLine {
  readonly entries: ReadonlyArray<AttachedTranscriptEntry>;
  readonly gitBranch: string | null;
  readonly model: string | null;
}

function toolDetail(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const fields = input as Record<string, unknown>;
  const preferred = [fields.command, fields.file_path, fields.path, fields.pattern, fields.url];
  const detail =
    preferred.find((value) => typeof value === "string" && value.trim().length > 0) ??
    Object.values(fields).find((value) => typeof value === "string" && value.trim().length > 0);
  if (typeof detail !== "string") return null;
  const trimmed = detail.trim();
  return trimmed.length > MAX_TOOL_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…`
    : trimmed;
}

/** `fallbackCreatedAt` is used when a record has no readable timestamp. */
export function parseAttachedTranscriptLine(
  line: string,
  fallbackCreatedAt: string,
): Option.Option<AttachedTranscriptLine> {
  if (line.trim().length === 0) return Option.none();
  const decoded = decodeTranscriptRecord(line);
  if (Option.isNone(decoded)) return Option.none();
  const record = decoded.value;
  if (record.type !== "user" && record.type !== "assistant") return Option.none();
  if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true) {
    return Option.none();
  }
  const uuid = record.uuid;
  const content = record.message?.content;
  if (uuid === undefined || content === undefined) return Option.none();

  const role = record.type;
  const createdAt =
    record.timestamp !== undefined && !Number.isNaN(Date.parse(record.timestamp))
      ? record.timestamp
      : fallbackCreatedAt;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const entries: Array<AttachedTranscriptEntry> = [];

  const joinedText = blocks
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n")
    .trim();
  // A message T3 injected (or any cross-session message) is mirrored back
  // wrapped in a `<cross-session-message …>` tag. Show the clean text instead.
  const text = role === "user" ? stripCrossSessionEnvelope(joinedText) : joinedText;
  const images =
    role === "user"
      ? blocks.flatMap((block): ReadonlyArray<AttachedTranscriptImage> => {
          const source = block.type === "image" ? block.source : undefined;
          return source?.type === "base64" &&
            source.media_type !== undefined &&
            source.data !== undefined
            ? [{ mediaType: source.media_type, base64: source.data }]
            : [];
        })
      : [];
  if (text.length > 0 || images.length > 0) {
    entries.push({ kind: "message", role, uuid, text, images, createdAt });
  }
  for (const block of blocks) {
    if (role === "assistant" && block.type === "tool_use" && block.id !== undefined) {
      entries.push({
        kind: "tool-started",
        toolUseId: block.id,
        name: block.name?.trim() || "Tool",
        detail: toolDetail(block.input),
        createdAt,
      });
    }
    if (role === "user" && block.type === "tool_result" && block.tool_use_id !== undefined) {
      entries.push({
        kind: "tool-completed",
        toolUseId: block.tool_use_id,
        failed: block.is_error === true,
        createdAt,
      });
    }
  }

  return Option.some({
    entries,
    gitBranch: record.gitBranch?.trim() || null,
    model: record.message?.model?.trim() || null,
  });
}
