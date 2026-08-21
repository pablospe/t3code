import type { SidebarThreadSummary } from "~/types";

import { firstValidTimestampMs, resolveSidebarThreadStatus } from "../Sidebar.logic";

export type BoardColumnKey = "backlog" | "planning" | "running" | "review" | "done";

export interface BoardColumnDefinition {
  readonly key: BoardColumnKey;
  readonly title: string;
  /** Shown inside an empty column so a blank board still explains itself. */
  readonly emptyHint: string;
}

export const BOARD_COLUMNS: ReadonlyArray<BoardColumnDefinition> = [
  { key: "backlog", title: "Backlog", emptyHint: "Threads created but not started land here" },
  { key: "planning", title: "Planning", emptyHint: "Plans awaiting your approval land here" },
  { key: "running", title: "Running", emptyHint: "Threads with agents working land here" },
  { key: "review", title: "Review", emptyHint: "Finished or blocked work that needs you" },
  // Archived threads never reach clients (the shell stream excludes them), so
  // in practice this column holds settled threads; archiving removes the card.
  { key: "done", title: "Done", emptyHint: "Settled threads land here" },
];

export type BoardThreadInput = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
>;

// The board stores nothing: every column is derived from the shell projection
// the sidebar already renders, so all clients agree without new state.
// Precedence deliberately checks attention before the explicit settle
// override, mirroring effectiveSettled's rule that blocked work stays
// visible regardless of overrides. Plan-phase threads stay in Planning even
// while their planning turn runs, so a card dropped there does not bounce
// to Running.
export function resolveBoardColumn(thread: BoardThreadInput): BoardColumnKey {
  if (thread.archivedAt !== null) {
    return "done";
  }

  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "failed") {
    return "review";
  }

  const active = status === "working" || status === "monitoring";
  if (thread.settledOverride === "settled" && !active) {
    return "done";
  }

  // Planning keys on the NATIVE signal first: an actionable proposed plan is
  // captured from the provider's own plan flow (Claude's ExitPlanMode)
  // regardless of T3's legacy thread mode. The interaction-mode check keeps
  // plan-phase threads (started via plan-mode turns) here too, including
  // while the planning turn itself is running.
  if (thread.hasActionableProposedPlan || thread.interactionMode === "plan") {
    return "planning";
  }

  if (active) {
    return "running";
  }

  if (thread.latestTurn === null) {
    return "backlog";
  }

  return "review";
}

// The drag decision tree: forward transitions only, plus dragging out of
// Done as the reverse door (unsettle). Everything else is inert - a drop
// with no server-side meaning must read as inactive, not silently fail.
const BOARD_TRANSITIONS: Record<BoardColumnKey, ReadonlyArray<BoardColumnKey>> = {
  backlog: ["planning", "done"],
  planning: ["running", "done"],
  running: ["done"],
  review: ["done"],
  done: ["backlog", "planning", "running", "review"],
};

export function isBoardTransitionAllowed(from: BoardColumnKey, to: BoardColumnKey): boolean {
  return from !== to && BOARD_TRANSITIONS[from].includes(to);
}

export interface BoardColumn<T extends BoardThreadInput> {
  readonly definition: BoardColumnDefinition;
  readonly threads: ReadonlyArray<T>;
}

type SortableBoardThread = BoardThreadInput &
  Pick<SidebarThreadSummary, "id" | "createdAt" | "updatedAt" | "latestUserMessageAt">;

// Columns order by most recent activity so the top of each lane is the thread
// you touched last; id breaks ties to keep the order stable across renders.
// resolveOverride lets the caller pin a thread to a column optimistically
// while a lifecycle command round-trips.
export function groupThreadsIntoBoardColumns<T extends SortableBoardThread>(
  threads: ReadonlyArray<T>,
  resolveOverride?: (thread: T) => BoardColumnKey | null,
): ReadonlyArray<BoardColumn<T>> {
  const byColumn: Record<BoardColumnKey, T[]> = {
    backlog: [],
    planning: [],
    running: [],
    review: [],
    done: [],
  };
  for (const thread of threads) {
    byColumn[resolveOverride?.(thread) ?? resolveBoardColumn(thread)].push(thread);
  }
  const activityMs = (thread: T) =>
    firstValidTimestampMs(thread.latestUserMessageAt, thread.updatedAt, thread.createdAt);
  return BOARD_COLUMNS.map((definition) => ({
    definition,
    threads: byColumn[definition.key].toSorted(
      (left, right) => activityMs(right) - activityMs(left) || left.id.localeCompare(right.id),
    ),
  }));
}
