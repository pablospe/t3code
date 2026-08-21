import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useProjectScopeStore } from "~/projectScopeStore";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { SidebarThreadSummary } from "~/types";

import { cn, newMessageId } from "~/lib/utils";

import type { SnoozePreset } from "../Sidebar.snooze";
import {
  type BoardColumn,
  type BoardColumnKey,
  groupThreadsIntoBoardColumns,
  isBoardTransitionAllowed,
  resolveBoardColumn,
} from "./boardColumns.logic";
import { BoardCard, type BoardCardDragData, BoardCardPreview } from "./BoardCard";

const boardKey = (environmentId: string, id: string) => `${environmentId}:${id}`;

const PLAN_KICKOFF_MESSAGE =
  "Plan the task described by this thread's title. Propose a concrete plan; do not implement anything yet.";
const EXECUTE_PLAN_MESSAGE = "Proceed: implement the proposed plan.";

function BoardColumnSection({
  column,
  dragFrom,
  projectTitles,
  onOpen,
  onSettle,
  onUnsettle,
  onArchive,
  onSnooze,
  onContextMenu,
  onNewThread,
  onArchiveAll,
}: {
  column: BoardColumn<SidebarThreadSummary>;
  dragFrom: BoardColumnKey | null;
  projectTitles: ReadonlyMap<string, string>;
  onOpen: (thread: SidebarThreadSummary) => void;
  onSettle: (thread: SidebarThreadSummary) => void;
  onUnsettle: (thread: SidebarThreadSummary) => void;
  onArchive: (thread: SidebarThreadSummary) => void;
  onSnooze: (thread: SidebarThreadSummary, preset: SnoozePreset) => void;
  onContextMenu: (thread: SidebarThreadSummary, position: { x: number; y: number }) => void;
  onNewThread: (() => void) | null;
  onArchiveAll: ((threads: ReadonlyArray<SidebarThreadSummary>) => void) | null;
}) {
  const validTarget =
    dragFrom !== null && isBoardTransitionAllowed(dragFrom, column.definition.key);
  const { isOver, setNodeRef } = useDroppable({
    id: column.definition.key,
    disabled: dragFrom !== null && !validTarget,
  });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex h-full min-w-64 flex-1 basis-0 flex-col rounded-xl bg-accent/30 transition-opacity",
        // While a drag is live, only legal targets stay interactive; the rest
        // fade so the decision tree is visible before the drop.
        dragFrom !== null && !validTarget && "opacity-35",
        isOver && validTarget && "ring-1 ring-ring",
      )}
    >
      <header className="flex shrink-0 items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {column.definition.title}
        </h2>
        <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
          {onNewThread ? (
            <button
              type="button"
              aria-label="New thread"
              title="New thread"
              onClick={onNewThread}
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : null}
          {onArchiveAll && column.threads.length > 0 ? (
            <button
              type="button"
              aria-label="Archive all settled threads"
              title="Archive all"
              onClick={() => onArchiveAll(column.threads)}
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArchiveIcon className="size-3.5" />
            </button>
          ) : null}
          {column.threads.length}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {column.threads.map((thread) => (
          <BoardCard
            key={boardKey(thread.environmentId, thread.id)}
            thread={thread}
            column={column.definition.key}
            projectTitle={
              projectTitles.get(boardKey(thread.environmentId, thread.projectId)) ??
              "Unknown project"
            }
            onOpen={onOpen}
            onSettle={onSettle}
            onUnsettle={onUnsettle}
            onArchive={onArchive}
            onSnooze={onSnooze}
            onContextMenu={onContextMenu}
          />
        ))}
        {column.threads.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground/60">
            {column.definition.emptyHint}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The board itself, host-agnostic: the full page and the drawer both render
    this. Project scope follows the sidebar's own selector (via
    projectScopeStore) - the board deliberately has no selector of its own.
    Navigation uses the router root so it works from any route. */
export function BoardContent({ compact = false }: { compact?: boolean } = {}) {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();
  const scopedProjectKeys = useProjectScopeStore((state) => state.scopedProjectKeys);
  const { handleNewThread, defaultProjectRef } = useHandleNewThread();
  const { settleThread, unsettleThread, snoozeThread, archiveThread } = useThreadActions();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [activeDrag, setActiveDrag] = useState<{
    thread: SidebarThreadSummary;
    column: BoardColumnKey;
  } | null>(null);
  // Optimistic column pins: a dropped card lands in its target immediately
  // while the lifecycle command round-trips; the pin clears once the derived
  // column catches up (or the thread changes again).
  const [columnPins, setColumnPins] = useState<ReadonlyMap<string, BoardColumnKey>>(new Map());
  // The 6px activation distance keeps plain clicks working even though the
  // drag listeners sit on the whole card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const filteredThreads = useMemo(
    () =>
      scopedProjectKeys === null
        ? threads
        : threads.filter((thread) =>
            scopedProjectKeys.has(boardKey(thread.environmentId, thread.projectId)),
          ),
    [threads, scopedProjectKeys],
  );

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(boardKey(project.environmentId, project.id), project.title);
    }
    return titles;
  }, [projects]);

  useEffect(() => {
    if (columnPins.size === 0) return;
    let changed = false;
    const next = new Map(columnPins);
    for (const thread of threads) {
      const key = boardKey(thread.environmentId, thread.id);
      const pinned = next.get(key);
      if (pinned && resolveBoardColumn(thread) === pinned) {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) setColumnPins(next);
  }, [threads, columnPins]);

  const columns = useMemo(
    () =>
      groupThreadsIntoBoardColumns(
        filteredThreads,
        (thread) => columnPins.get(boardKey(thread.environmentId, thread.id)) ?? null,
      ),
    [filteredThreads, columnPins],
  );

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

  // One context menu for the whole board: the card sets the target, the
  // effect opens the sidebar-equivalent thread menu at the pointer.
  const [menuTarget, setMenuTarget] = useState<{
    thread: SidebarThreadSummary;
    position: { x: number; y: number };
    openedAt: number;
  } | null>(null);
  const menuThreadRef = menuTarget
    ? scopeThreadRef(menuTarget.thread.environmentId, menuTarget.thread.id)
    : null;
  const menuProjectCwd = menuTarget
    ? (projects.find(
        (project) =>
          project.id === menuTarget.thread.projectId &&
          project.environmentId === menuTarget.thread.environmentId,
      )?.workspaceRoot ?? null)
    : null;
  const { openMenu } = useThreadActionMenu({
    threadRef: menuThreadRef,
    projectCwd: menuProjectCwd,
    changeRequestState: null,
    // The board has no inline rename; the thread header does, so go there.
    onStartRename: () => {
      if (menuTarget) openThread(menuTarget.thread);
    },
  });
  const lastOpenedMenuAt = useRef(0);
  useEffect(() => {
    if (menuTarget && menuTarget.openedAt !== lastOpenedMenuAt.current) {
      lastOpenedMenuAt.current = menuTarget.openedAt;
      openMenu(menuTarget.position);
    }
  }, [menuTarget, openMenu]);
  const showCardContextMenu = useCallback(
    (thread: SidebarThreadSummary, position: { x: number; y: number }) => {
      setMenuTarget({ thread, position, openedAt: Date.now() });
    },
    [],
  );

  const pinColumn = useCallback((thread: SidebarThreadSummary, column: BoardColumnKey) => {
    setColumnPins((previous) =>
      new Map(previous).set(boardKey(thread.environmentId, thread.id), column),
    );
  }, []);

  const settle = useCallback(
    (thread: SidebarThreadSummary) => {
      void settleThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [settleThread],
  );
  const unsettle = useCallback(
    (thread: SidebarThreadSummary) => {
      void unsettleThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [unsettleThread],
  );
  const archive = useCallback(
    (thread: SidebarThreadSummary) => {
      void archiveThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [archiveThread],
  );
  const archiveAll = useCallback(
    (columnThreads: ReadonlyArray<SidebarThreadSummary>) => {
      for (const thread of columnThreads) {
        void archiveThread(scopeThreadRef(thread.environmentId, thread.id));
      }
    },
    [archiveThread],
  );
  const snooze = useCallback(
    (thread: SidebarThreadSummary, preset: SnoozePreset) => {
      void snoozeThread(scopeThreadRef(thread.environmentId, thread.id), preset.snoozedUntil);
    },
    [snoozeThread],
  );

  const startThreadTurn = useCallback(
    (thread: SidebarThreadSummary, text: string, interactionMode: "default" | "plan") => {
      void startTurn({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode ?? "auto",
          interactionMode,
        },
      });
    },
    [startTurn],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as BoardCardDragData | undefined;
      if (!data) return;
      const thread = filteredThreads.find(
        (candidate) =>
          candidate.id === data.threadId && candidate.environmentId === data.environmentId,
      );
      setActiveDrag(thread ? { thread, column: data.column } : null);
    },
    [filteredThreads],
  );

  // Drops execute the decision tree: into Done settles (deferred while the
  // thread still runs - the server settles it once quiet), out of Done
  // unsettles, Backlog->Planning starts a native plan-mode turn, and
  // Planning->Running starts the execution turn. Anything else was already
  // rejected by the droppable gating.
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragged = activeDrag;
      setActiveDrag(null);
      const target = event.over?.id as BoardColumnKey | undefined;
      if (!dragged || !target) return;
      const { thread, column: from } = dragged;
      if (!isBoardTransitionAllowed(from, target)) return;

      if (target === "done") {
        settle(thread);
        pinColumn(thread, "done");
        return;
      }
      if (from === "done") {
        unsettle(thread);
        return;
      }
      const busy = thread.session?.status === "running" || thread.session?.status === "starting";
      if (from === "backlog" && target === "planning") {
        if (busy) return;
        startThreadTurn(thread, PLAN_KICKOFF_MESSAGE, "plan");
        pinColumn(thread, "planning");
        return;
      }
      if (from === "planning" && target === "running") {
        // A planning turn still in flight cannot be pushed into execution.
        if (busy) return;
        startThreadTurn(thread, EXECUTE_PLAN_MESSAGE, "default");
        pinColumn(thread, "running");
      }
    },
    [activeDrag, settle, unsettle, startThreadTurn, pinColumn],
  );

  const newThreadInScope = useCallback(() => {
    // A single-project scope pins the new draft to it; otherwise the
    // contextual default project decides, same as the sidebar's new-thread.
    let projectRef = defaultProjectRef;
    if (scopedProjectKeys?.size === 1) {
      const [onlyKey] = scopedProjectKeys;
      if (onlyKey) {
        const separator = onlyKey.indexOf(":");
        projectRef = scopeProjectRef(
          onlyKey.slice(0, separator) as EnvironmentId,
          onlyKey.slice(separator + 1) as ProjectId,
        );
      }
    }
    if (projectRef) void handleNewThread(projectRef);
  }, [scopedProjectKeys, defaultProjectRef, handleNewThread]);

  if (!bootstrapped && threads.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connecting…
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      {/* Columns scroll horizontally in their own container; the host never does. */}
      <div
        className={
          compact
            ? "flex h-full min-h-0 gap-2 overflow-x-auto p-2 pb-2.5"
            : "flex h-full min-h-0 gap-3 overflow-x-auto p-4"
        }
      >
        {columns.map((column) => (
          <BoardColumnSection
            key={column.definition.key}
            column={column}
            dragFrom={activeDrag?.column ?? null}
            projectTitles={projectTitles}
            onOpen={openThread}
            onSettle={settle}
            onUnsettle={unsettle}
            onArchive={archive}
            onSnooze={snooze}
            onContextMenu={showCardContextMenu}
            onNewThread={column.definition.key === "backlog" ? newThreadInScope : null}
            onArchiveAll={column.definition.key === "done" ? archiveAll : null}
          />
        ))}
      </div>
      {/* dropAnimation off: the source card never moved (the overlay is the
          dragged visual), so the default snap-back reads as a glitch. */}
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <BoardCardPreview
            thread={activeDrag.thread}
            projectTitle={
              projectTitles.get(
                boardKey(activeDrag.thread.environmentId, activeDrag.thread.projectId),
              ) ?? "Unknown project"
            }
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
