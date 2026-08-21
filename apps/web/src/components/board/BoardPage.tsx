import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useThreadActions } from "~/hooks/useThreadActions";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { SidebarThreadSummary } from "~/types";

import type { SnoozePreset } from "../Sidebar.snooze";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { type BoardColumn, groupThreadsIntoBoardColumns } from "./boardColumns.logic";
import { BoardCard, type BoardCardDragData } from "./BoardCard";

const routeApi = getRouteApi("/_chat/board");

const ALL_PROJECTS = "all";

const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

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
      className={`flex h-full w-72 shrink-0 flex-col rounded-xl bg-accent/30 ${
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
            key={projectKey(thread.environmentId, thread.id)}
            thread={thread}
            column={column.definition.key}
            projectTitle={
              projectTitles.get(projectKey(thread.environmentId, thread.projectId)) ??
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

export function BoardPage() {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate({ from: "/board" });
  const search = routeApi.useSearch();
  const { handleNewThread, defaultProjectRef } = useHandleNewThread();
  const { settleThread, unsettleThread, snoozeThread } = useThreadActions();
  // The 6px activation distance keeps plain clicks working even though the
  // drag listeners sit on the whole card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const filteredThreads = useMemo(
    () =>
      search.project
        ? threads.filter(
            (thread) =>
              thread.projectId === search.project &&
              (!search.environment || thread.environmentId === search.environment),
          )
        : threads,
    [threads, search.project, search.environment],
  );

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(projectKey(project.environmentId, project.id), project.title);
    }
    return titles;
  }, [projects]);

  const columns = useMemo(() => groupThreadsIntoBoardColumns(filteredThreads), [filteredThreads]);

  const filterValue = search.project
    ? `${search.environment ?? ""}:${search.project}`
    : ALL_PROJECTS;
  const filterLabel = search.project
    ? (projectTitles.get(filterValue) ?? "Unknown project")
    : "All projects";

  const setProjectFilter = useCallback(
    (value: string) => {
      void navigate({
        // Rebuilt rather than spread so a cleared filter leaves the URL.
        search: () => {
          if (value === ALL_PROJECTS) return {};
          const separator = value.indexOf(":");
          return {
            environment: value.slice(0, separator) as EnvironmentId,
            project: value.slice(separator + 1) as ProjectId,
          };
        },
        replace: true,
      });
    },
    [navigate],
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

  // Drops map onto the two lifecycle commands that exist: into Done = settle,
  // out of Done = unsettle. Every other move has no server meaning and snaps back.
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
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
    const projectRef =
      search.project && search.environment
        ? scopeProjectRef(search.environment, search.project)
        : defaultProjectRef;
    if (projectRef) void handleNewThread(projectRef);
  }, [search.project, search.environment, defaultProjectRef, handleNewThread]);

  if (!bootstrapped && threads.length === 0) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Connecting…
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">Board</h1>
          <Menu>
            <MenuTrigger
              aria-label="Filter by project"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {filterLabel}
              <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" className="min-w-40">
              <MenuRadioGroup
                value={filterValue}
                onValueChange={(next) => setProjectFilter(next as string)}
              >
                <MenuRadioItem value={ALL_PROJECTS}>All projects</MenuRadioItem>
                {projects.map((project) => (
                  <MenuRadioItem
                    key={projectKey(project.environmentId, project.id)}
                    value={projectKey(project.environmentId, project.id)}
                  >
                    {project.title}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </header>
        {/* Columns scroll horizontally in their own container; the page never does. */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
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
        </DndContext>
      </div>
    </SidebarInset>
  );
}
