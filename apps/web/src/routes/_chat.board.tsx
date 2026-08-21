import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/board/BoardPage";

export const Route = createFileRoute("/_chat/board")({
  component: BoardPage,
});
