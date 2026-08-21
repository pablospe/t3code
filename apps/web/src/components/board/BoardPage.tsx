import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useProjects } from "~/state/entities";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { BoardContent } from "./BoardContent";

const routeApi = getRouteApi("/_chat/board");

const ALL_PROJECTS = "all";

const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

export function BoardPage() {
  const projects = useProjects();
  const navigate = useNavigate({ from: "/board" });
  const search = routeApi.useSearch();

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(projectKey(project.environmentId, project.id), project.title);
    }
    return titles;
  }, [projects]);

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
        <div className="min-h-0 flex-1">
          <BoardContent project={search.project} environment={search.environment} />
        </div>
      </div>
    </SidebarInset>
  );
}
