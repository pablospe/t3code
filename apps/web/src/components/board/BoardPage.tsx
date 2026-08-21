import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { SidebarInset } from "../ui/sidebar";
import { BoardContent } from "./BoardContent";
import { BoardProjectFilter } from "./BoardProjectFilter";

const routeApi = getRouteApi("/_chat/board");

export function BoardPage() {
  const navigate = useNavigate({ from: "/board" });
  const search = routeApi.useSearch();

  const setProjectFilter = useCallback(
    (filter: { environmentId: EnvironmentId; projectId: ProjectId } | null) => {
      void navigate({
        // Rebuilt rather than spread so a cleared filter leaves the URL.
        search: () =>
          filter ? { environment: filter.environmentId, project: filter.projectId } : {},
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">Board</h1>
          <BoardProjectFilter
            environment={search.environment ?? null}
            project={search.project ?? null}
            onChange={setProjectFilter}
          />
        </header>
        <div className="min-h-0 flex-1">
          <BoardContent project={search.project} environment={search.environment} />
        </div>
      </div>
    </SidebarInset>
  );
}
