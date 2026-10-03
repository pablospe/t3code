import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "~/test-fixtures";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

import {
  BOARD_COLUMNS,
  groupThreadsIntoBoardColumns,
  isBoardCardDraggable,
  isBoardTransitionAllowed,
  isThreadSnoozed,
  resolveBoardColumn,
  resolveDoneReturnColumn,
  substituteBoardPromptPlaceholders,
} from "./boardColumns.logic";

const environmentId = EnvironmentId.make("environment-board");
const at = (iso: string) => DateTime.makeUnsafe(iso);

// Cards are derived from what the server actually sends, so every case starts
// from a raw V2 shell and goes through the client's own presentation step.
function makeShell(overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  return presentThreadShell(environmentId, { ...makeThreadFixture().source, ...overrides });
}

const finishedRun = {
  latestRunId: RunId.make("run-1"),
  status: "completed",
  latestRunRequestedAt: at("2026-08-20T10:00:00.000Z"),
  latestRunStartedAt: at("2026-08-20T10:00:05.000Z"),
  latestRunCompletedAt: at("2026-08-20T10:04:00.000Z"),
} satisfies Partial<OrchestrationV2ThreadShell>;

const runningRun = {
  latestRunId: RunId.make("run-1"),
  activeRunId: RunId.make("run-1"),
  status: "running",
  latestRunRequestedAt: at("2026-08-20T10:00:00.000Z"),
  latestRunStartedAt: at("2026-08-20T10:00:05.000Z"),
} satisfies Partial<OrchestrationV2ThreadShell>;

const pendingRequest = (kind: "permission" | "user_input") => ({
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request-1"),
    kind,
    createdAt: at("2026-08-20T10:01:00.000Z"),
  },
});

describe("resolveBoardColumn", () => {
  it("puts archived threads in done regardless of other state", () => {
    const thread = makeShell({
      ...runningRun,
      ...pendingRequest("permission"),
      archivedAt: at("2026-08-20T12:00:00.000Z"),
    });
    expect(resolveBoardColumn(thread)).toBe("done");
  });

  it("keeps blocked work visible: a pending approval outranks an explicit settle", () => {
    const thread = makeShell({
      ...runningRun,
      ...pendingRequest("permission"),
      settledOverride: "settled",
    });
    expect(resolveBoardColumn(thread)).toBe("review");
  });

  it("keeps running work visible: an active run outranks an explicit settle", () => {
    const thread = makeShell({ ...runningRun, settledOverride: "settled" });
    expect(resolveBoardColumn(thread)).toBe("running");
  });

  it("puts explicitly settled quiet threads in done", () => {
    const thread = makeShell({ ...finishedRun, settledOverride: "settled" });
    expect(resolveBoardColumn(thread)).toBe("done");
  });

  it("maps every in-flight run status to running", () => {
    for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
      expect(resolveBoardColumn(makeShell({ ...runningRun, status }))).toBe("running");
    }
  });

  it("keeps a run whose background work will wake it in running", () => {
    const thread = makeShell({
      ...finishedRun,
      pendingBackgroundTasks: [{ taskId: "watch-ci", kind: "monitor" }],
    });
    expect(resolveBoardColumn(thread)).toBe("running");
  });

  it("does not hold a finished run for a command it left running", () => {
    const thread = makeShell({
      ...finishedRun,
      pendingBackgroundTasks: [{ taskId: "dev-server", kind: "command" }],
    });
    expect(resolveBoardColumn(thread)).toBe("review");
  });

  it("routes pending user input, failures and usage limits to review", () => {
    expect(resolveBoardColumn(makeShell({ ...runningRun, ...pendingRequest("user_input") }))).toBe(
      "review",
    );
    expect(
      resolveBoardColumn(makeShell({ ...finishedRun, status: "failed", lastError: "boom" })),
    ).toBe("review");
    expect(
      resolveBoardColumn(
        makeShell({ ...finishedRun, status: "failed", lastErrorClass: "usage_limit" }),
      ),
    ).toBe("review");
  });

  it("puts an actionable plan on a finished plan-mode run in planning", () => {
    const thread = makeShell({
      ...finishedRun,
      interactionMode: "plan",
      hasActionableProposedPlan: true,
    });
    expect(resolveBoardColumn(thread)).toBe("planning");
  });

  it("keeps any quiet plan-mode thread that has run in planning", () => {
    expect(resolveBoardColumn(makeShell({ ...finishedRun, interactionMode: "plan" }))).toBe(
      "planning",
    );
  });

  it("puts a natively captured proposed plan in planning even in default mode", () => {
    expect(resolveBoardColumn(makeShell({ ...finishedRun, hasActionableProposedPlan: true }))).toBe(
      "planning",
    );
  });

  it("keeps plan-phase threads in planning even while running or unstarted", () => {
    expect(resolveBoardColumn(makeShell({ ...runningRun, interactionMode: "plan" }))).toBe(
      "planning",
    );
    expect(resolveBoardColumn(makeShell({ interactionMode: "plan" }))).toBe("planning");
  });

  it("moves an approved plan's implementation run to running, then review", () => {
    // Approving switches the thread to default mode and dispatches with
    // sourcePlanRef, which completes the plan: both planning signals drop.
    expect(resolveBoardColumn(makeShell({ ...runningRun, hasActionableProposedPlan: false }))).toBe(
      "running",
    );
    expect(
      resolveBoardColumn(makeShell({ ...finishedRun, hasActionableProposedPlan: false })),
    ).toBe("review");
  });

  it("routes plan-phase attention states to review", () => {
    expect(
      resolveBoardColumn(
        makeShell({ ...runningRun, ...pendingRequest("permission"), interactionMode: "plan" }),
      ),
    ).toBe("review");
  });

  it("puts threads that never ran in backlog", () => {
    expect(resolveBoardColumn(makeShell())).toBe("backlog");
  });

  it("puts quiet threads with a finished run in review", () => {
    expect(resolveBoardColumn(makeShell(finishedRun))).toBe("review");
  });
});

describe("terminal-session threads", () => {
  // Mirrored CLI sessions have no runs: their own activity drives the column.
  const terminalSession = (status?: "running" | "waiting" | "idle" | "ended") =>
    makeShell({
      externalSession: {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeSessionId: "native-session-1",
        ...(status === undefined
          ? {}
          : {
              activity: {
                status,
                waitingReason: status === "waiting" ? "permission prompt" : null,
                workStartedAt: null,
              },
            }),
      },
    });

  it("follows the session's activity instead of landing in backlog", () => {
    expect(resolveBoardColumn(terminalSession("running"))).toBe("running");
    expect(resolveBoardColumn(terminalSession("waiting"))).toBe("running");
    expect(resolveBoardColumn(terminalSession("idle"))).toBe("review");
    expect(resolveBoardColumn(terminalSession("ended"))).toBe("done");
    // Not yet seen by the server: quiet, so ready for review.
    expect(resolveBoardColumn(terminalSession())).toBe("review");
  });

  it("keeps a session waiting in the terminal in running, as the sidebar marks it", () => {
    const waiting = terminalSession("waiting");
    expect(resolveSidebarThreadStatus(waiting)).toBe("terminal");
    expect(resolveBoardColumn(waiting)).toBe("running");
  });

  it("leaves ordinary threads on the run rules beside terminal sessions", () => {
    // Real presented shells: a plain unstarted thread is Backlog, never Review.
    const unstarted = makeShell();
    expect(unstarted.externalSessionStatus).toBeNull();
    expect(resolveBoardColumn(unstarted)).toBe("backlog");
    expect(resolveBoardColumn(makeShell({ title: "Add subtract v2" }))).toBe("backlog");
    expect(resolveBoardColumn(terminalSession("idle"))).toBe("review");
    // A shell presented before the field existed reads as an ordinary thread.
    const { externalSessionStatus: _omitted, ...legacy } = unstarted;
    expect(resolveBoardColumn(legacy as typeof unstarted)).toBe("backlog");
    expect(isBoardCardDraggable(legacy as typeof unstarted)).toBe(true);
  });

  it("keeps a live session in running even when settled", () => {
    expect(resolveBoardColumn({ ...terminalSession("running"), settledOverride: "settled" })).toBe(
      "running",
    );
    expect(resolveBoardColumn({ ...terminalSession("waiting"), settledOverride: "settled" })).toBe(
      "running",
    );
  });

  it("still honors archive and an explicit settle", () => {
    expect(
      resolveBoardColumn({
        ...terminalSession("running"),
        archivedAt: "2026-08-20T12:00:00.000Z",
      }),
    ).toBe("done");
    expect(resolveBoardColumn({ ...terminalSession("idle"), settledOverride: "settled" })).toBe(
      "done",
    );
  });

  it("is read-only: its cards never drag, ordinary cards do", () => {
    expect(isBoardCardDraggable(terminalSession("idle"))).toBe(false);
    expect(isBoardCardDraggable(makeShell())).toBe(true);
  });
});

describe("substituteBoardPromptPlaceholders", () => {
  it("replaces every {title} with the card's title", () => {
    expect(
      substituteBoardPromptPlaceholders("/opsx:propose {title} - {title}", {
        title: "Fix the board",
      }),
    ).toBe("/opsx:propose Fix the board - Fix the board");
  });

  it("fills {task} with the stored details", () => {
    expect(
      substituteBoardPromptPlaceholders("{title}\n\nTask: {task}", {
        title: "Fix the board",
        details: "Cards dropped on Planning must send the full brief.",
      }),
    ).toBe("Fix the board\n\nTask: Cards dropped on Planning must send the full brief.");
  });

  it("falls back to the title when details are missing or blank", () => {
    for (const details of [undefined, null, "   "]) {
      expect(substituteBoardPromptPlaceholders("{task}", { title: "Fix the board", details })).toBe(
        "Fix the board",
      );
    }
  });
});

describe("isBoardTransitionAllowed", () => {
  it("follows the forward decision tree", () => {
    expect(isBoardTransitionAllowed("backlog", "planning")).toBe(true);
    expect(isBoardTransitionAllowed("backlog", "done")).toBe(true);
    expect(isBoardTransitionAllowed("backlog", "running")).toBe(false);
    expect(isBoardTransitionAllowed("backlog", "review")).toBe(false);
    expect(isBoardTransitionAllowed("planning", "running")).toBe(true);
    expect(isBoardTransitionAllowed("planning", "done")).toBe(true);
    expect(isBoardTransitionAllowed("planning", "backlog")).toBe(false);
    expect(isBoardTransitionAllowed("running", "done")).toBe(true);
    expect(isBoardTransitionAllowed("running", "review")).toBe(false);
    expect(isBoardTransitionAllowed("review", "done")).toBe(true);
    expect(isBoardTransitionAllowed("review", "planning")).toBe(true);
    expect(isBoardTransitionAllowed("review", "running")).toBe(true);
    expect(isBoardTransitionAllowed("review", "backlog")).toBe(false);
  });

  it("routes done drags only to the true unsettle destination", () => {
    expect(isBoardTransitionAllowed("done", "review")).toBe(false);
    expect(resolveDoneReturnColumn(makeShell({ ...finishedRun, settledOverride: "settled" }))).toBe(
      "review",
    );
    expect(
      resolveDoneReturnColumn(
        makeShell({ ...finishedRun, settledOverride: "settled", interactionMode: "plan" }),
      ),
    ).toBe("planning");
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
    const older = makeShell({
      id: ThreadId.make("thread-old"),
      updatedAt: at("2026-08-19T10:00:00.000Z"),
    });
    const newer = makeShell({
      id: ThreadId.make("thread-new"),
      updatedAt: at("2026-08-20T10:00:00.000Z"),
      latestUserMessageAt: at("2026-08-20T18:00:00.000Z"),
    });
    const backlog = groupThreadsIntoBoardColumns([older, newer]).find(
      (column) => column.definition.key === "backlog",
    );
    expect(backlog?.threads.map((thread) => thread.id)).toEqual(["thread-new", "thread-old"]);
  });

  it("sinks snoozed threads to the column tail ordered by wake time", () => {
    const NOW = Date.parse("2026-08-21T12:00:00.000Z");
    const awake = makeShell({
      id: ThreadId.make("thread-awake"),
      updatedAt: at("2026-08-19T10:00:00.000Z"),
    });
    const wakesLater = makeShell({
      id: ThreadId.make("thread-later"),
      updatedAt: at("2026-08-21T11:00:00.000Z"),
      snoozedUntil: at("2026-08-22T09:00:00.000Z"),
    });
    const wakesSoon = makeShell({
      id: ThreadId.make("thread-soon"),
      updatedAt: at("2026-08-21T11:30:00.000Z"),
      snoozedUntil: at("2026-08-21T15:00:00.000Z"),
    });
    const backlog = groupThreadsIntoBoardColumns(
      [wakesLater, awake, wakesSoon],
      undefined,
      NOW,
    ).find((column) => column.definition.key === "backlog");
    expect(backlog?.threads.map((thread) => thread.id)).toEqual([
      "thread-awake",
      "thread-soon",
      "thread-later",
    ]);
    // A passed wake time stops classifying as snoozed - the thread floats back.
    expect(isThreadSnoozed(wakesSoon, Date.parse("2026-08-21T16:00:00.000Z"))).toBe(false);
    expect(isThreadSnoozed(wakesSoon, NOW)).toBe(true);
    expect(isThreadSnoozed(awake, NOW)).toBe(false);
  });

  it("splits threads into their derived columns and honors pins", () => {
    const running = makeShell({ ...runningRun, id: ThreadId.make("thread-running") });
    const done = makeShell({
      id: ThreadId.make("thread-done"),
      archivedAt: at("2026-08-20T12:00:00.000Z"),
    });
    const pinned = makeShell({ id: ThreadId.make("thread-pinned") });
    const columns = groupThreadsIntoBoardColumns([running, done, pinned], (thread) =>
      thread.id === pinned.id ? "planning" : null,
    );
    const byKey = new Map(columns.map((column) => [column.definition.key, column.threads]));
    expect(byKey.get("running")?.map((thread) => thread.id)).toEqual(["thread-running"]);
    expect(byKey.get("done")?.map((thread) => thread.id)).toEqual(["thread-done"]);
    expect(byKey.get("planning")?.map((thread) => thread.id)).toEqual(["thread-pinned"]);
    expect(byKey.get("backlog")).toEqual([]);
  });
});
