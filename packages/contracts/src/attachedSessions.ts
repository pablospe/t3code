import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * An attached session is a Claude CLI session that runs outside T3 Code (for
 * example in a terminal). The server mirrors it into a thread whose
 * `externalSession` names it, and the terminal stays its only owner.
 */
const ATTACHED_CLAUDE_THREAD_ID_PREFIX = "attached:claude:";

/**
 * Deliberately never registered as a provider instance, so a client that does
 * not know about external sessions resolves no provider for these threads and
 * keeps its composer disabled.
 */
export const ATTACHED_CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAttached");

/**
 * Deterministic, so a session keeps its thread across restarts and the mirror
 * adopts threads created before Orchestrator V2 instead of duplicating them.
 */
export function attachedClaudeThreadId(sessionId: string): ThreadId {
  return ThreadId.make(`${ATTACHED_CLAUDE_THREAD_ID_PREFIX}${sessionId}`);
}
