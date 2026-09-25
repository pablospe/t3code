import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/board/BoardPage";

export interface BoardSearch {
  project?: string;
}

export const Route = createFileRoute("/_chat/board")({
  // `?project=` scopes the board to one project by id or title, independent of
  // the sidebar's own selector. An unusable value is simply dropped.
  validateSearch: (raw: Record<string, unknown>): BoardSearch =>
    typeof raw.project === "string" && raw.project ? { project: raw.project.slice(0, 200) } : {},
  component: BoardPage,
});
