import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/board/BoardPage";

export interface BoardSearch {
  readonly project?: ProjectId;
  readonly environment?: EnvironmentId;
}

export const Route = createFileRoute("/_chat/board")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ...(typeof raw.project === "string" && raw.project
      ? { project: raw.project.slice(0, 200) as ProjectId }
      : {}),
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: raw.environment.slice(0, 200) as EnvironmentId }
      : {}),
  }),
  component: BoardPage,
});
