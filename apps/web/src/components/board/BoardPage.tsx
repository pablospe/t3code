import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { SidebarThreadSummary } from "~/types";

import { SidebarInset } from "../ui/sidebar";
import { groupThreadsIntoBoardColumns } from "./boardColumns.logic";
import { BoardCard } from "./BoardCard";

const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

export function BoardPage() {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(projectKey(project.environmentId, project.id), project.title);
    }
    return titles;
  }, [projects]);

  const columns = useMemo(() => groupThreadsIntoBoardColumns(threads), [threads]);

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

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
        <header className="shrink-0 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">Board</h1>
        </header>
        {/* Columns scroll horizontally in their own container; the page never does. */}
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          {columns.map((column) => (
            <section
              key={column.definition.key}
              className="flex h-full w-72 shrink-0 flex-col rounded-xl bg-accent/30"
            >
              <header className="flex shrink-0 items-center justify-between px-3 py-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {column.definition.title}
                </h2>
                <span className="text-xs text-muted-foreground/70">{column.threads.length}</span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {column.threads.map((thread) => (
                  <BoardCard
                    key={projectKey(thread.environmentId, thread.id)}
                    thread={thread}
                    projectTitle={
                      projectTitles.get(projectKey(thread.environmentId, thread.projectId)) ??
                      "Unknown project"
                    }
                    onOpen={openThread}
                  />
                ))}
                {column.threads.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground/60">
                    {column.definition.emptyHint}
                  </p>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </div>
    </SidebarInset>
  );
}
