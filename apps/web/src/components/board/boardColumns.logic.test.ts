import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "~/types";

import {
  BOARD_COLUMNS,
  groupThreadsIntoBoardColumns,
  resolveBoardColumn,
} from "./boardColumns.logic";

type TestThread = Parameters<typeof resolveBoardColumn>[0] &
  Pick<SidebarThreadSummary, "id" | "createdAt" | "updatedAt" | "latestUserMessageAt">;

const makeSession = (
  status: NonNullable<SidebarThreadSummary["session"]>["status"],
  activeTurnId: string | null = null,
) => ({ status, activeTurnId }) as unknown as SidebarThreadSummary["session"];

const completedTurn = {
  turnId: "turn-1",
  state: "completed",
  requestedAt: "2026-08-20T10:00:00.000Z",
  startedAt: "2026-08-20T10:00:05.000Z",
  completedAt: "2026-08-20T10:04:00.000Z",
  assistantMessageId: null,
} as unknown as SidebarThreadSummary["latestTurn"];

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1" as SidebarThreadSummary["id"],
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    latestUserMessageAt: null,
    archivedAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestTurn: null,
    session: null,
    backgroundLiveness: null,
    ...overrides,
  };
}

describe("resolveBoardColumn", () => {
  it("puts archived threads in done regardless of other state", () => {
    const thread = makeThread({
      archivedAt: "2026-08-20T12:00:00.000Z",
      session: makeSession("running", "turn-1"),
      hasPendingApprovals: true,
    });
    expect(resolveBoardColumn(thread)).toBe("done");
  });

  it("keeps blocked work visible: pending approval outranks an explicit settle", () => {
    const thread = makeThread({ settledOverride: "settled", hasPendingApprovals: true });
    expect(resolveBoardColumn(thread)).toBe("review");
  });

  it("keeps running work visible: a live session outranks an explicit settle", () => {
    const thread = makeThread({
      settledOverride: "settled",
      session: makeSession("running", "turn-1"),
    });
    expect(resolveBoardColumn(thread)).toBe("running");
  });

  it("puts explicitly settled idle threads in done", () => {
    const thread = makeThread({ settledOverride: "settled", latestTurn: completedTurn });
    expect(resolveBoardColumn(thread)).toBe("done");
  });

  it("maps a starting session and background liveness to running", () => {
    expect(resolveBoardColumn(makeThread({ session: makeSession("starting") }))).toBe("running");
    expect(resolveBoardColumn(makeThread({ backgroundLiveness: "monitoring" }))).toBe("running");
  });

  it("routes awaiting-input and failed sessions to review", () => {
    expect(resolveBoardColumn(makeThread({ hasPendingUserInput: true }))).toBe("review");
    expect(resolveBoardColumn(makeThread({ session: makeSession("error") }))).toBe("review");
  });

  it("puts an actionable plan on a settled plan-mode turn in planning", () => {
    const thread = makeThread({
      interactionMode: "plan",
      latestTurn: completedTurn,
      hasActionableProposedPlan: true,
    });
    expect(resolveBoardColumn(thread)).toBe("planning");
  });

  it("puts threads that never ran a turn in backlog", () => {
    expect(resolveBoardColumn(makeThread())).toBe("backlog");
  });

  it("puts quiet threads with a finished turn in review", () => {
    expect(resolveBoardColumn(makeThread({ latestTurn: completedTurn }))).toBe("review");
  });
});

describe("groupThreadsIntoBoardColumns", () => {
  it("returns every column in board order, including empty ones", () => {
    const columns = groupThreadsIntoBoardColumns([]);
    expect(columns.map((column) => column.definition.key)).toEqual(
      BOARD_COLUMNS.map((definition) => definition.key),
    );
    expect(columns.every((column) => column.threads.length === 0)).toBe(true);
  });

  it("orders a column by most recent activity, newest first", () => {
    const older = makeThread({
      id: "thread-old" as SidebarThreadSummary["id"],
      updatedAt: "2026-08-19T10:00:00.000Z",
    });
    const newer = makeThread({
      id: "thread-new" as SidebarThreadSummary["id"],
      updatedAt: "2026-08-20T10:00:00.000Z",
      latestUserMessageAt: "2026-08-20T18:00:00.000Z",
    });
    const columns = groupThreadsIntoBoardColumns([older, newer]);
    const backlog = columns.find((column) => column.definition.key === "backlog");
    expect(backlog?.threads.map((thread) => thread.id)).toEqual(["thread-new", "thread-old"]);
  });

  it("splits threads into their derived columns", () => {
    const running = makeThread({
      id: "thread-running" as SidebarThreadSummary["id"],
      session: makeSession("running", "turn-1"),
    });
    const done = makeThread({
      id: "thread-done" as SidebarThreadSummary["id"],
      archivedAt: "2026-08-20T12:00:00.000Z",
    });
    const columns = groupThreadsIntoBoardColumns([running, done]);
    const byKey = new Map(columns.map((column) => [column.definition.key, column.threads]));
    expect(byKey.get("running")?.map((thread) => thread.id)).toEqual(["thread-running"]);
    expect(byKey.get("done")?.map((thread) => thread.id)).toEqual(["thread-done"]);
    expect(byKey.get("backlog")).toEqual([]);
  });
});
