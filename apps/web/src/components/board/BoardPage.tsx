import { SidebarInset } from "../ui/sidebar";
import { BoardContent } from "./BoardContent";

/** Full-page board. Project scope follows the sidebar's selector, so this
    page is just a chrome-less host for the shared board content. */
export function BoardPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">Board</h1>
        </header>
        <div className="min-h-0 flex-1">
          <BoardContent />
        </div>
      </div>
    </SidebarInset>
  );
}
