import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

const ALL_PROJECTS = "all";

const filterKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

/** Compact project selector shared by the board page (URL-backed) and the
    board drawer (store-backed): value in, `{environmentId, projectId} | null`
    out, options resolved from the live project shells. */
export function BoardProjectFilter({
  environment,
  project,
  onChange,
}: {
  environment: EnvironmentId | null | undefined;
  project: ProjectId | null | undefined;
  onChange: (filter: { environmentId: EnvironmentId; projectId: ProjectId } | null) => void;
}) {
  const projects = useProjects();

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const projectShell of projects) {
      titles.set(filterKey(projectShell.environmentId, projectShell.id), projectShell.title);
    }
    return titles;
  }, [projects]);

  const value = project ? filterKey(environment ?? "", project) : ALL_PROJECTS;
  const label = project ? (projectTitles.get(value) ?? "Unknown project") : "All projects";

  return (
    <Menu>
      <MenuTrigger
        aria-label="Filter by project"
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {label}
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-40">
        <MenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === ALL_PROJECTS) {
              onChange(null);
              return;
            }
            const key = next as string;
            const separator = key.indexOf(":");
            onChange({
              environmentId: key.slice(0, separator) as EnvironmentId,
              projectId: key.slice(separator + 1) as ProjectId,
            });
          }}
        >
          <MenuRadioItem value={ALL_PROJECTS}>All projects</MenuRadioItem>
          {projects.map((projectShell) => (
            <MenuRadioItem
              key={filterKey(projectShell.environmentId, projectShell.id)}
              value={filterKey(projectShell.environmentId, projectShell.id)}
            >
              {projectShell.title}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
