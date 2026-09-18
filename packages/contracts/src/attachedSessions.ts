import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * An attached session is a Claude CLI session that runs outside T3 Code (for
 * example in a terminal). The server mirrors it into a thread, and the terminal
 * stays the only owner, so these threads are read-only everywhere.
 */
const ATTACHED_CLAUDE_THREAD_ID_PREFIX = "attached:claude:";

/**
 * Deliberately never registered as a provider instance, so clients resolve no
 * provider for these threads and keep their composers disabled.
 */
export const ATTACHED_CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAttached");

export function attachedClaudeThreadId(sessionId: string): ThreadId {
  return ThreadId.make(`${ATTACHED_CLAUDE_THREAD_ID_PREFIX}${sessionId}`);
}

export function isAttachedSessionThreadId(threadId: string): boolean {
  return threadId.startsWith(ATTACHED_CLAUDE_THREAD_ID_PREFIX);
}
