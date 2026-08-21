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
import { PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useProjectScopeStore } from "~/projectScopeStore";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { SidebarThreadSummary } from "~/types";

import type { SnoozePreset } from "../Sidebar.snooze";
import { type BoardColumn, groupThreadsIntoBoardColumns } from "./boardColumns.logic";
import { BoardCard, type BoardCardDragData, BoardCardPreview } from "./BoardCard";

const boardKey = (environmentId: string, id: string) => `${environmentId}:${id}`;

function BoardColumnSection({
  column,
  projectTitles,
  onOpen,
  onSettle,
  onUnsettle,
  onSnooze,
  onNewThread,
}: {
  column: BoardColumn<SidebarThreadSummary>;
  projectTitles: ReadonlyMap<string, string>;
  onOpen: (thread: SidebarThreadSummary) => void;
  onSettle: (thread: SidebarThreadSummary) => void;
  onUnsettle: (thread: SidebarThreadSummary) => void;
  onSnooze: (thread: SidebarThreadSummary, preset: SnoozePreset) => void;
  onNewThread: (() => void) | null;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.definition.key });
  return (
    <section
      ref={setNodeRef}
      className={`flex h-full min-w-64 flex-1 basis-0 flex-col rounded-xl bg-accent/30 ${
        isOver ? "ring-1 ring-ring" : ""
      }`}
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
            onSnooze={onSnooze}
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
export function BoardContent() {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();
  const scopedProjectKeys = useProjectScopeStore((state) => state.scopedProjectKeys);
  const { handleNewThread, defaultProjectRef } = useHandleNewThread();
  const { settleThread, unsettleThread, snoozeThread } = useThreadActions();
  const [activeDrag, setActiveDrag] = useState<SidebarThreadSummary | null>(null);
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
    for (const projectShell of projects) {
      titles.set(boardKey(projectShell.environmentId, projectShell.id), projectShell.title);
    }
    return titles;
  }, [projects]);

  const columns = useMemo(() => groupThreadsIntoBoardColumns(filteredThreads), [filteredThreads]);

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

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
  const snooze = useCallback(
    (thread: SidebarThreadSummary, preset: SnoozePreset) => {
      void snoozeThread(scopeThreadRef(thread.environmentId, thread.id), preset.snoozedUntil);
    },
    [snoozeThread],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as BoardCardDragData | undefined;
      if (!data) return;
      setActiveDrag(
        filteredThreads.find(
          (thread) => thread.id === data.threadId && thread.environmentId === data.environmentId,
        ) ?? null,
      );
    },
    [filteredThreads],
  );

  // Drops map onto the two lifecycle commands that exist: into Done = settle,
  // out of Done = unsettle. Every other move has no server meaning and snaps back.
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      const target = event.over?.id;
      const data = event.active.data.current as BoardCardDragData | undefined;
      if (!target || !data) return;
      const ref = scopeThreadRef(data.environmentId, data.threadId);
      if (target === "done" && data.column !== "done") {
        void settleThread(ref);
      } else if (target !== "done" && data.column === "done") {
        void unsettleThread(ref);
      }
    },
    [settleThread, unsettleThread],
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
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-4">
        {columns.map((column) => (
          <BoardColumnSection
            key={column.definition.key}
            column={column}
            projectTitles={projectTitles}
            onOpen={openThread}
            onSettle={settle}
            onUnsettle={unsettle}
            onSnooze={snooze}
            onNewThread={column.definition.key === "backlog" ? newThreadInScope : null}
          />
        ))}
      </div>
      <DragOverlay>
        {activeDrag ? (
          <BoardCardPreview
            thread={activeDrag}
            projectTitle={
              projectTitles.get(boardKey(activeDrag.environmentId, activeDrag.projectId)) ??
              "Unknown project"
            }
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
