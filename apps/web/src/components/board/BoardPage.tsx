import { getRouteApi } from "@tanstack/react-router";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";

import { SidebarInset } from "../ui/sidebar";
import { BoardContent } from "./BoardContent";
import { BoardPromptsEditor } from "./BoardPromptsEditor";

const routeApi = getRouteApi("/_chat/board");

/** Full-page board. Project scope follows the sidebar's selector unless
    `?project=` names one, so this page is a chrome-less host for the shared
    board content. */
export function BoardPage() {
  const { project: projectParam } = routeApi.useSearch();
  const projects = useProjects();
  // An unmatched param scopes nothing: better the whole board than an empty
  // one from a typo.
  const scopeOverride = useMemo(() => {
    if (!projectParam) return undefined;
    const keys = new Set<string>();
    for (const project of projects) {
      if (
        project.id === projectParam ||
        project.title.toLowerCase() === projectParam.toLowerCase()
      ) {
        keys.add(`${project.environmentId}:${project.id}`);
      }
    }
    return keys.size > 0 ? (keys as ReadonlySet<string>) : undefined;
  }, [projectParam, projects]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">Board</h1>
          <BoardPromptsEditor />
        </header>
        <div className="min-h-0 flex-1">
          <BoardContent scopeOverride={scopeOverride} />
        </div>
      </div>
    </SidebarInset>
  );
}
