import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useBoardPromptsStore } from "~/boardPromptsStore";
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

import { cn, newMessageId, newThreadId } from "~/lib/utils";

import type { SnoozePreset } from "../Sidebar.snooze";
import {
  type BoardColumn,
  type BoardColumnKey,
  groupThreadsIntoBoardColumns,
  isBoardTransitionAllowed,
  resolveBoardColumn,
  resolveDoneReturnColumn,
} from "./boardColumns.logic";
import { BoardBacklogDialog } from "./BoardBacklogDialog";
import { BoardCard, type BoardCardDragData, BoardCardPreview } from "./BoardCard";
import { BoardPromptsEditor } from "./BoardPromptsEditor";

const boardKey = (environmentId: string, id: string) => `${environmentId}:${id}`;

function BoardColumnSection({
  column,
  dragFrom,
  dragReturn,
  projectTitles,
  onOpen,
  onSettle,
  onUnsettle,
  onArchive,
  onDelete,
  onSnooze,
  onUnsnooze,
  onContextMenu,
  onNewThread,
  onArchiveAll,
  now,
}: {
  column: BoardColumn<SidebarThreadSummary>;
  dragFrom: BoardColumnKey | null;
  /** For drags out of Done: the single column unsettling really returns to. */
  dragReturn: BoardColumnKey | null;
  projectTitles: ReadonlyMap<string, string>;
  onOpen: (thread: SidebarThreadSummary) => void;
  onSettle: (thread: SidebarThreadSummary) => void;
  onUnsettle: (thread: SidebarThreadSummary) => void;
  onArchive: (thread: SidebarThreadSummary) => void;
  onDelete: (thread: SidebarThreadSummary) => void;
  onSnooze: (thread: SidebarThreadSummary, preset: SnoozePreset) => void;
  onUnsnooze: (thread: SidebarThreadSummary) => void;
  onContextMenu: (thread: SidebarThreadSummary, position: { x: number; y: number }) => void;
  onNewThread: (() => void) | null;
  onArchiveAll: ((threads: ReadonlyArray<SidebarThreadSummary>) => void) | null;
  now: number;
}) {
  const validTarget =
    dragFrom !== null &&
    (dragFrom === "done"
      ? column.definition.key === dragReturn
      : isBoardTransitionAllowed(dragFrom, column.definition.key));
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
              aria-label="New backlog task"
              title="New backlog task"
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
            onDelete={onDelete}
            onSnooze={onSnooze}
            onUnsnooze={onUnsnooze}
            onContextMenu={onContextMenu}
            now={now}
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
    projectScopeStore) unless the host passes an override - the board
    deliberately has no selector of its own. Navigation uses the router root so
    it works from any route. */
export function BoardContent({
  compact = false,
  scopeOverride,
}: { compact?: boolean; scopeOverride?: ReadonlySet<string> | undefined } = {}) {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();
  const scopedProjectKeys = useProjectScopeStore((state) => state.scopedProjectKeys);
  const scope = scopeOverride !== undefined ? scopeOverride : scopedProjectKeys;
  const { defaultProjectRef } = useHandleNewThread();
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    archiveThread,
    confirmAndDeleteThread,
  } = useThreadActions();
  const boardPrompts = useBoardPromptsStore((state) => state.prompts);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const [backlogDialogOpen, setBacklogDialogOpen] = useState(false);
  const [activeDrag, setActiveDrag] = useState<{
    thread: SidebarThreadSummary;
    column: BoardColumnKey;
  } | null>(null);
  // Optimistic column pins: a dropped card lands in its target immediately
  // while the lifecycle command round-trips. A pin exists ONLY to bridge that
  // round-trip: it clears when the derived column catches up and expires on
  // its own regardless, so a rejected or deferred command can never leave the
  // board lying about where a thread is.
  const [columnPins, setColumnPins] = useState<
    ReadonlyMap<string, { column: BoardColumnKey; expiresAt: number }>
  >(new Map());
  // The 6px activation distance keeps plain clicks working even though the
  // drag listeners sit on the whole card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // Minute tick so snoozed cards wake (un-dim, float back up) when their
  // snoozedUntil passes - a timer, not an animation.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const filteredThreads = useMemo(
    () =>
      scope === null
        ? threads
        : threads.filter((thread) => scope.has(boardKey(thread.environmentId, thread.projectId))),
    [threads, scope],
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
    const prune = () => {
      setColumnPins((previous) => {
        if (previous.size === 0) return previous;
        const now = Date.now();
        let changed = false;
        const next = new Map(previous);
        for (const [key, pin] of previous) {
          const thread = threads.find(
            (candidate) => boardKey(candidate.environmentId, candidate.id) === key,
          );
          if (pin.expiresAt <= now || !thread || resolveBoardColumn(thread) === pin.column) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    };
    prune();
    const soonest = Math.min(...[...columnPins.values()].map((pin) => pin.expiresAt));
    const timer = setTimeout(prune, Math.max(250, soonest - Date.now()));
    return () => clearTimeout(timer);
  }, [threads, columnPins]);

  const columns = useMemo(() => {
    const now = Date.now();
    return groupThreadsIntoBoardColumns(
      filteredThreads,
      (thread) => {
        const pin = columnPins.get(boardKey(thread.environmentId, thread.id));
        return pin && pin.expiresAt > now ? pin.column : null;
      },
      nowTick,
    );
  }, [filteredThreads, columnPins, nowTick]);

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
    // Blocked threads (pending approval/input) can't effectively change
    // lifecycle - the command defers server-side - so pinning them would
    // show a move that hasn't happened. Let the derived column tell the truth.
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) return;
    setColumnPins((previous) =>
      new Map(previous).set(boardKey(thread.environmentId, thread.id), {
        column,
        expiresAt: Date.now() + 8_000,
      }),
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
  const unsnooze = useCallback(
    (thread: SidebarThreadSummary) => {
      void unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [unsnoozeThread],
  );
  const deleteWithConfirm = useCallback(
    (thread: SidebarThreadSummary) => {
      void confirmAndDeleteThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [confirmAndDeleteThread],
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
            // Prompts address a card by name: "{title}" is the only
            // placeholder, so a prompt can carry the task into a slash command.
            text: text.replaceAll("{title}", thread.title),
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
  // unsettles back to its true column, Backlog->Planning starts a native
  // plan-mode turn, Review->Planning starts a re-plan turn, and
  // Planning->Running starts the execution turn. Anything else was already
  // rejected by the droppable gating.
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragged = activeDrag;
      setActiveDrag(null);
      const target = event.over?.id as BoardColumnKey | undefined;
      if (!dragged || !target) return;
      const { thread, column: from } = dragged;

      if (from === "done") {
        // Unsettle only lands where the derivation says - the single target
        // the droppable gating offered.
        if (target === resolveDoneReturnColumn(thread)) unsettle(thread);
        return;
      }
      if (!isBoardTransitionAllowed(from, target)) return;

      if (target === "done") {
        settle(thread);
        pinColumn(thread, "done");
        return;
      }
      // A turn already in flight cannot be pushed into a new one.
      const busy = thread.session?.status === "running" || thread.session?.status === "starting";
      if (busy) return;
      if (from === "backlog" && target === "planning") {
        startThreadTurn(thread, boardPrompts.backlogToPlanning, "plan");
        pinColumn(thread, "planning");
        return;
      }
      if (from === "review" && target === "planning") {
        startThreadTurn(thread, boardPrompts.reviewToPlanning, "plan");
        pinColumn(thread, "planning");
        return;
      }
      if (from === "review" && target === "running") {
        startThreadTurn(thread, boardPrompts.reviewToRunning, "default");
        pinColumn(thread, "running");
        return;
      }
      if (from === "planning" && target === "running") {
        startThreadTurn(thread, boardPrompts.planningToRunning, "default");
        pinColumn(thread, "running");
      }
    },
    [activeDrag, settle, unsettle, startThreadTurn, pinColumn, boardPrompts],
  );

  // A single-project scope pins the new task to it; otherwise the contextual
  // default project decides, same as the sidebar's new-thread.
  const newTaskProject = useMemo(() => {
    let projectRef = defaultProjectRef;
    if (scope?.size === 1) {
      const [onlyKey] = scope;
      if (onlyKey) {
        const separator = onlyKey.indexOf(":");
        projectRef = scopeProjectRef(
          onlyKey.slice(0, separator) as EnvironmentId,
          onlyKey.slice(separator + 1) as ProjectId,
        );
      }
    }
    if (!projectRef) return null;
    return (
      projects.find(
        (project) =>
          project.id === projectRef.projectId && project.environmentId === projectRef.environmentId,
      ) ?? null
    );
  }, [scope, defaultProjectRef, projects]);

  // A backlog thread is created without a turn, so it still needs a model on
  // it: the project default, else whatever the user last worked with.
  const newTaskModelSelection = useMemo(() => {
    if (newTaskProject?.defaultModelSelection) return newTaskProject.defaultModelSelection;
    let latestInProject: SidebarThreadSummary | null = null;
    let latestAnywhere: SidebarThreadSummary | null = null;
    for (const thread of threads) {
      if (latestAnywhere === null || thread.updatedAt > latestAnywhere.updatedAt) {
        latestAnywhere = thread;
      }
      if (
        newTaskProject &&
        thread.projectId === newTaskProject.id &&
        thread.environmentId === newTaskProject.environmentId &&
        (latestInProject === null || thread.updatedAt > latestInProject.updatedAt)
      ) {
        latestInProject = thread;
      }
    }
    return latestInProject?.modelSelection ?? latestAnywhere?.modelSelection ?? null;
  }, [newTaskProject, threads]);

  const openBacklogDialog = useCallback(() => setBacklogDialogOpen(true), []);

  const createBacklogTask = useCallback(
    (title: string) => {
      if (!newTaskProject || !newTaskModelSelection) return;
      void createThread({
        environmentId: newTaskProject.environmentId,
        input: {
          threadId: newThreadId(),
          projectId: newTaskProject.id,
          title,
          modelSelection: newTaskModelSelection,
          runtimeMode: "auto",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
    },
    [createThread, newTaskProject, newTaskModelSelection],
  );

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
      // pointerWithin, not closestCenter: with the decision tree disabling
      // most droppables, closestCenter turns the one legal column into a
      // magnet that catches drops made anywhere. A drop must physically land
      // inside a column to mean anything.
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <div className="relative h-full min-h-0">
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
              dragReturn={
                activeDrag?.column === "done" ? resolveDoneReturnColumn(activeDrag.thread) : null
              }
              projectTitles={projectTitles}
              onOpen={openThread}
              onSettle={settle}
              onUnsettle={unsettle}
              onArchive={archive}
              onDelete={deleteWithConfirm}
              onSnooze={snooze}
              onUnsnooze={unsnooze}
              onContextMenu={showCardContextMenu}
              onNewThread={column.definition.key === "backlog" ? openBacklogDialog : null}
              onArchiveAll={column.definition.key === "done" ? archiveAll : null}
              now={nowTick}
            />
          ))}
        </div>
        {/* The drawer host has no header, so the prompts editor rides the
            board itself. */}
        {compact ? (
          <BoardPromptsEditor className="absolute right-2 bottom-2 z-10 rounded-md border border-border bg-card/90 shadow-sm" />
        ) : null}
      </div>
      <BoardBacklogDialog
        open={backlogDialogOpen}
        onOpenChange={setBacklogDialogOpen}
        projectTitle={newTaskProject?.title ?? null}
        modelAvailable={newTaskProject !== null && newTaskModelSelection !== null}
        onCreate={createBacklogTask}
      />
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
