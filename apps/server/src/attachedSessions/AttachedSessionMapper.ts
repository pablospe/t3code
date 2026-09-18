/**
 * Pure mapping from an attached Claude CLI session to orchestration commands.
 *
 * Every id is derived from the session and the transcript record, never random.
 * Re-reading a transcript therefore produces the same command ids, and command
 * receipts absorb the replay without emitting a second event.
 */
import {
  ATTACHED_CLAUDE_INSTANCE_ID,
  CommandId,
  EventId,
  MessageId,
  type ChatImageAttachment,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type ThreadId,
} from "@t3tools/contracts";

import type { AttachedTranscriptEntry } from "./AttachedSessionTranscript.ts";

export type AttachedSessionCliStatus = "busy" | "waiting" | "idle";

export interface AttachedToolCall {
  readonly name: string;
  readonly detail: string | null;
}

const ATTACHED_APPROVAL_REQUEST_TYPE = "attached_terminal";

const commandId = (sessionId: string, tag: string, key: string) =>
  CommandId.make(`attached:${sessionId}:${tag}:${key}`);

export const attachedMessageId = (sessionId: string, uuid: string) =>
  MessageId.make(`attached:${sessionId}:${uuid}`);

export const attachedToolActivityId = (
  sessionId: string,
  toolUseId: string,
  phase: "started" | "completed",
) => EventId.make(`attached:${sessionId}:${toolUseId}:${phase}`);

function toolItemType(name: string): string {
  if (name === "Bash") return "command_execution";
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    return "file_change";
  }
  if (name.startsWith("mcp__")) return "mcp_tool_call";
  if (name === "WebSearch" || name === "WebFetch") return "web_search";
  return "dynamic_tool_call";
}

/** `busy` and `waiting` both read as running; waiting adds an open approval on top. */
export function attachedSessionStatus(
  status: AttachedSessionCliStatus,
): OrchestrationSessionStatus {
  return status === "idle" ? "ready" : "running";
}

export function attachedSessionSetCommand(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly status: OrchestrationSessionStatus;
  readonly now: string;
}): OrchestrationCommand {
  return {
    type: "thread.session.set",
    commandId: commandId(input.sessionId, "session", `${input.status}:${input.now}`),
    threadId: input.threadId,
    session: {
      threadId: input.threadId,
      status: input.status,
      providerName: ATTACHED_CLAUDE_INSTANCE_ID,
      providerInstanceId: ATTACHED_CLAUDE_INSTANCE_ID,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: input.now,
    },
    createdAt: input.now,
  };
}

export const attachedWaitRequestId = (sessionId: string, openedAt: string) =>
  `attached:${sessionId}:wait:${openedAt}`;

/** Opens or closes the "waiting on you in the terminal" approval that drives the sidebar pill. */
export function attachedWaitCommand(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly phase: "requested" | "resolved";
  readonly waitingFor: string | null;
  readonly now: string;
}): OrchestrationCommand {
  const kind = input.phase === "requested" ? "approval.requested" : "approval.resolved";
  return {
    type: "thread.activity.append",
    commandId: commandId(input.sessionId, kind, input.requestId),
    threadId: input.threadId,
    activity: {
      id: EventId.make(`${input.requestId}:${input.phase}`),
      tone: "approval",
      kind,
      summary:
        input.phase === "requested"
          ? "Waiting for you in the terminal"
          : "Answered in the terminal",
      payload: {
        requestId: input.requestId,
        requestType: ATTACHED_APPROVAL_REQUEST_TYPE,
        ...(input.phase === "requested"
          ? { detail: `Waiting in the terminal: ${input.waitingFor ?? "your input"}` }
          : {}),
      },
      turnId: null,
      createdAt: input.now,
    },
    createdAt: input.now,
  };
}

/**
 * Commands for one live transcript entry. `toolCalls` remembers started tools so
 * the completion row can repeat their title; it is updated in place.
 */
export function attachedEntryCommands(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly entry: AttachedTranscriptEntry;
  readonly toolCalls: Map<string, AttachedToolCall>;
  /** Images of a user message, already written to the attachment store. */
  readonly attachments?: ReadonlyArray<ChatImageAttachment>;
}): ReadonlyArray<OrchestrationCommand> {
  const { sessionId, threadId, entry } = input;
  switch (entry.kind) {
    case "message": {
      const messageId = attachedMessageId(sessionId, entry.uuid);
      if (entry.role === "user") {
        if (entry.text.length === 0 && (input.attachments ?? []).length === 0) return [];
        return [
          {
            type: "thread.message.user.append",
            commandId: commandId(sessionId, "user", entry.uuid),
            threadId,
            message: { messageId, text: entry.text, attachments: input.attachments ?? [] },
            createdAt: entry.createdAt,
          },
        ];
      }
      return [
        {
          type: "thread.message.assistant.delta",
          commandId: commandId(sessionId, "assistant-delta", entry.uuid),
          threadId,
          messageId,
          delta: entry.text,
          createdAt: entry.createdAt,
        },
        {
          type: "thread.message.assistant.complete",
          commandId: commandId(sessionId, "assistant-complete", entry.uuid),
          threadId,
          messageId,
          createdAt: entry.createdAt,
        },
      ];
    }
    case "tool-started": {
      input.toolCalls.set(entry.toolUseId, { name: entry.name, detail: entry.detail });
      return [
        toolActivityCommand({
          sessionId,
          threadId,
          toolUseId: entry.toolUseId,
          phase: "started",
          tool: { name: entry.name, detail: entry.detail },
          status: "inProgress",
          createdAt: entry.createdAt,
        }),
      ];
    }
    case "tool-completed": {
      const tool = input.toolCalls.get(entry.toolUseId) ?? { name: "Tool", detail: null };
      input.toolCalls.delete(entry.toolUseId);
      return [
        toolActivityCommand({
          sessionId,
          threadId,
          toolUseId: entry.toolUseId,
          phase: "completed",
          tool,
          status: entry.failed ? "failed" : "completed",
          createdAt: entry.createdAt,
        }),
      ];
    }
  }
}

function toolActivityCommand(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly toolUseId: string;
  readonly phase: "started" | "completed";
  readonly tool: AttachedToolCall;
  readonly status: "inProgress" | "completed" | "failed";
  readonly createdAt: string;
}): OrchestrationCommand {
  return {
    type: "thread.activity.append",
    commandId: commandId(input.sessionId, `tool-${input.phase}`, input.toolUseId),
    threadId: input.threadId,
    activity: {
      id: attachedToolActivityId(input.sessionId, input.toolUseId, input.phase),
      tone: "tool",
      kind: input.phase === "started" ? "tool.updated" : "tool.completed",
      summary: input.tool.name,
      payload: {
        itemType: toolItemType(input.tool.name),
        toolCallId: input.toolUseId,
        status: input.status,
        title: input.tool.name,
        ...(input.tool.detail !== null ? { detail: input.tool.detail } : {}),
      },
      turnId: null,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/** One batched import for the conversation that already exists when a session is first seen. */
export function attachedHistoryImportCommand(input: {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<AttachedTranscriptEntry>;
  readonly maxMessages: number;
}): OrchestrationCommand | null {
  const messages = input.entries
    .flatMap((entry) => (entry.kind === "message" && entry.text.length > 0 ? [entry] : []))
    .slice(-input.maxMessages)
    .map((entry) => ({
      messageId: attachedMessageId(input.sessionId, entry.uuid),
      role: entry.role,
      text: entry.text,
      createdAt: entry.createdAt,
    }));
  if (messages.length === 0) return null;
  return {
    type: "thread.history.import",
    commandId: commandId(input.sessionId, "history-import", "initial"),
    threadId: input.threadId,
    messages,
  };
}
