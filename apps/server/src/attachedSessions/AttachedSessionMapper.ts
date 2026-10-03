/**
 * Pure mapping from an attached Claude CLI session to Orchestration V2 events.
 *
 * Everything is runless, like the agent session importer's history. What the
 * session is doing lives on the thread's `externalSession.activity`, which
 * follows the CLI roster. Message and turn item ids are derived from the session and the
 * transcript record, so re-reading a transcript upserts the same records instead
 * of duplicating them. Event ids are left to the caller, because the event log
 * keeps every write.
 */
import {
  ATTACHED_CLAUDE_INSTANCE_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProviderDriverKind,
  TurnItemId,
  type ChatImageAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExternalSession,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { AttachedTranscriptEntry } from "./AttachedSessionTranscript.ts";

export const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** An event before the caller gives it an id. */
export type AttachedEventDraft = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id">
    : never
  : never;

type AttachedSessionCliStatus = "busy" | "waiting" | "idle";

export type AttachedActivityStatus = NonNullable<
  NonNullable<OrchestrationV2ExternalSession["activity"]>
>["status"];

export const ATTACHED_ACTIVITY_STATUSES: ReadonlySet<string> = new Set<AttachedActivityStatus>([
  "running",
  "waiting",
  "idle",
  "ended",
]);

export interface AttachedToolCall {
  readonly name: string;
  readonly detail: string | null;
  /** The turn item's ordinal, so the completion keeps the started row in place. */
  readonly ordinal?: number;
}

export function attachedActivityStatus(status: AttachedSessionCliStatus): AttachedActivityStatus {
  return status === "busy" ? "running" : status;
}

const attachedMessageId = (sessionId: string, uuid: string) =>
  MessageId.make(`attached:${sessionId}:${uuid}`);

const attachedTurnItemId = (sessionId: string, key: string) =>
  TurnItemId.make(`attached:${sessionId}:item:${key}`);

const at = (iso: string) => DateTime.makeUnsafe(iso);

export function attachedThread(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly model: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly now: string;
}): OrchestrationV2AppThread {
  const now = at(input.now);
  return {
    createdBy: "system",
    creationSource: "server",
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: ATTACHED_CLAUDE_INSTANCE_ID,
    modelSelection: { instanceId: ATTACHED_CLAUDE_INSTANCE_ID, model: input.model ?? "claude" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.branch,
    worktreePath: input.worktreePath,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: null,
    externalSession: { driver: CLAUDE_DRIVER, nativeSessionId: input.sessionId },
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    // The session's lifetime decides when it leaves the active list, not inactivity.
    autoSettleDisabledAt: now,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function itemBase(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly key: string;
  readonly ordinal: number;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}) {
  return {
    id: attachedTurnItemId(input.sessionId, input.key),
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: input.status,
    title: input.title,
    startedAt: at(input.startedAt),
    completedAt: input.completedAt === null ? null : at(input.completedAt),
    updatedAt: at(input.completedAt ?? input.startedAt),
  };
}

function attachedMessageEvents(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly uuid: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatImageAttachment>;
  readonly createdAt: string;
  readonly ordinal: number;
}): ReadonlyArray<AttachedEventDraft> {
  const messageId = attachedMessageId(input.sessionId, input.uuid);
  const createdAt = at(input.createdAt);
  const createdBy = input.role === "user" ? "user" : "agent";
  const base = itemBase({
    sessionId: input.sessionId,
    threadId: input.threadId,
    key: input.uuid,
    ordinal: input.ordinal,
    status: "completed",
    title: null,
    startedAt: input.createdAt,
    completedAt: input.createdAt,
  });
  const turnItem: OrchestrationV2TurnItem =
    input.role === "user"
      ? {
          ...base,
          createdBy,
          creationSource: "provider",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.text,
          attachments: input.attachments,
        }
      : { ...base, type: "assistant_message", messageId, text: input.text, streaming: false };
  return [
    {
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: createdAt,
      payload: {
        createdBy,
        creationSource: "provider",
        id: messageId,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role: input.role,
        text: input.text,
        attachments: input.attachments,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: createdAt,
      payload: turnItem,
    },
  ];
}

/** Claude Code's tool names, mapped to the closest turn item the timeline renders. */
function toolTurnItem(
  base: ReturnType<typeof itemBase>,
  tool: AttachedToolCall,
): OrchestrationV2TurnItem {
  const detail = tool.detail;
  switch (tool.name) {
    case "Bash":
      return { ...base, type: "command_execution", input: detail ?? tool.name };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      if (detail !== null) return { ...base, type: "file_change", fileName: detail };
      break;
    case "Grep":
    case "Glob":
      return { ...base, type: "file_search", ...(detail === null ? {} : { pattern: detail }) };
    case "WebSearch":
    case "WebFetch":
      return { ...base, type: "web_search", patterns: detail === null ? [] : [detail] };
  }
  return { ...base, type: "dynamic_tool", toolName: tool.name, input: detail ?? {} };
}

export function attachedToolEvent(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly toolUseId: string;
  readonly tool: AttachedToolCall;
  readonly ordinal: number;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly completedAt: string | null;
}): AttachedEventDraft {
  const base = itemBase({
    sessionId: input.sessionId,
    threadId: input.threadId,
    key: `tool:${input.toolUseId}`,
    ordinal: input.ordinal,
    status: input.status,
    title: input.tool.name,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
  return {
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: base.updatedAt,
    payload: toolTurnItem(base, input.tool),
  };
}

/**
 * Events for one live transcript entry. `toolCalls` remembers started tools so
 * the completion keeps their title and place; it is updated in place.
 * `nextOrdinal` hands out the next timeline ordinal.
 */
export function attachedEntryEvents(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly entry: AttachedTranscriptEntry;
  readonly toolCalls: Map<string, AttachedToolCall>;
  /** Images of a user message, already written to the attachment store. */
  readonly attachments?: ReadonlyArray<ChatImageAttachment>;
  readonly nextOrdinal: () => number;
}): ReadonlyArray<AttachedEventDraft> {
  const { sessionId, threadId, entry } = input;
  switch (entry.kind) {
    case "message": {
      const attachments = input.attachments ?? [];
      if (entry.text.length === 0 && attachments.length === 0) return [];
      return attachedMessageEvents({
        sessionId,
        threadId,
        uuid: entry.uuid,
        role: entry.role,
        text: entry.text,
        attachments: entry.role === "user" ? attachments : [],
        createdAt: entry.createdAt,
        ordinal: input.nextOrdinal(),
      });
    }
    case "tool-started": {
      const tool = { name: entry.name, detail: entry.detail, ordinal: input.nextOrdinal() };
      input.toolCalls.set(entry.toolUseId, tool);
      return [
        attachedToolEvent({
          sessionId,
          threadId,
          toolUseId: entry.toolUseId,
          tool,
          ordinal: tool.ordinal,
          status: "running",
          startedAt: entry.createdAt,
          completedAt: null,
        }),
      ];
    }
    case "tool-completed": {
      const tool = input.toolCalls.get(entry.toolUseId) ?? { name: "Tool", detail: null };
      input.toolCalls.delete(entry.toolUseId);
      return [
        attachedToolEvent({
          sessionId,
          threadId,
          toolUseId: entry.toolUseId,
          tool,
          ordinal: tool.ordinal ?? input.nextOrdinal(),
          status: entry.failed ? "failed" : "completed",
          startedAt: entry.createdAt,
          completedAt: entry.createdAt,
        }),
      ];
    }
  }
}

/**
 * The conversation that already exists when a session is first seen, as text
 * only. Tools and images from before the attach are not replayed.
 */
export function attachedBackfillEvents(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<AttachedTranscriptEntry>;
  readonly maxMessages: number;
  readonly firstOrdinal: number;
}): ReadonlyArray<AttachedEventDraft> {
  return input.entries
    .flatMap((entry) => (entry.kind === "message" && entry.text.length > 0 ? [entry] : []))
    .slice(-input.maxMessages)
    .flatMap((entry, index) =>
      attachedMessageEvents({
        sessionId: input.sessionId,
        threadId: input.threadId,
        uuid: entry.uuid,
        role: entry.role,
        text: entry.text,
        attachments: [],
        createdAt: entry.createdAt,
        ordinal: input.firstOrdinal + index,
      }),
    );
}

/** Left on the thread when a message from T3 did not reach the session. */
export function attachedSendFailureEvent(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly detail: string;
  readonly text: string;
  readonly ordinal: number;
  readonly now: string;
}): AttachedEventDraft {
  const quoted = input.text.length > 500 ? `${input.text.slice(0, 499)}…` : input.text;
  const base = itemBase({
    sessionId: input.sessionId,
    threadId: input.threadId,
    key: `send-failed:${input.requestId}`,
    ordinal: input.ordinal,
    status: "failed",
    title: "Message not delivered",
    startedAt: input.now,
    completedAt: input.now,
  });
  return {
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at(input.now),
    payload: {
      ...base,
      type: "system_notice",
      message: `Your message did not reach the terminal session: ${input.detail}\n\n> ${quoted.replaceAll("\n", "\n> ")}`,
    },
  };
}
