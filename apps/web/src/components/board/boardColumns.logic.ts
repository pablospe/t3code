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
// Precedence deliberately checks attention and activity before the explicit
// settle override, mirroring effectiveSettled's rule that blocked or running
// work stays visible regardless of overrides.
export function resolveBoardColumn(thread: BoardThreadInput): BoardColumnKey {
  if (thread.archivedAt !== null) {
    return "done";
  }

  const status = resolveSidebarThreadStatus(thread);
  if (status === "working" || status === "monitoring") {
    return "running";
  }
  if (status === "approval" || status === "input" || status === "failed") {
    return "review";
  }

  if (thread.settledOverride === "settled") {
    return "done";
  }

  // Any plan-mode thread that has run and is quiet is in its planning phase:
  // drafting, proposing, or awaiting a plan decision. Attention states
  // (approval/input) still route to review above - those need the user NOW.
  if (thread.interactionMode === "plan" && thread.latestTurn !== null) {
    return "planning";
  }

  if (thread.latestTurn === null) {
    return "backlog";
  }

  return "review";
}

export interface BoardColumn<T extends BoardThreadInput> {
  readonly definition: BoardColumnDefinition;
  readonly threads: ReadonlyArray<T>;
}

type SortableBoardThread = BoardThreadInput &
  Pick<SidebarThreadSummary, "id" | "createdAt" | "updatedAt" | "latestUserMessageAt">;

// Columns order by most recent activity so the top of each lane is the thread
// you touched last; id breaks ties to keep the order stable across renders.
export function groupThreadsIntoBoardColumns<T extends SortableBoardThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<BoardColumn<T>> {
  const byColumn: Record<BoardColumnKey, T[]> = {
    backlog: [],
    planning: [],
    running: [],
    review: [],
    done: [],
  };
  for (const thread of threads) {
    byColumn[resolveBoardColumn(thread)].push(thread);
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
