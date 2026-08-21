import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarThreadSummary } from "~/types";

import { firstValidTimestamp, resolveThreadStatusPill } from "../Sidebar.logic";

function BoardCardImpl({
  thread,
  projectTitle,
  onOpen,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
  onOpen: (thread: SidebarThreadSummary) => void;
}) {
  const pill = resolveThreadStatusPill({ thread });
  const activityAt = firstValidTimestamp(
    thread.latestUserMessageAt,
    thread.updatedAt,
    thread.createdAt,
  );
  return (
    <button
      type="button"
      onClick={() => onOpen(thread)}
      className={cn(
        "w-full rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen cards skip style, layout and paint; a tall column costs
        // what the viewport shows. The intrinsic size keeps scrolling honest.
        "[contain-intrinsic-block-size:72px] [content-visibility:auto]",
      )}
    >
      <span className="block truncate text-sm font-medium text-foreground">{thread.title}</span>
      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/70">
        <span className="truncate">{projectTitle}</span>
        {thread.branch ? <span className="truncate">{thread.branch}</span> : null}
        {activityAt ? (
          <span className="ml-auto shrink-0">{formatRelativeTimeLabel(activityAt)}</span>
        ) : null}
      </span>
      {pill ? (
        <span className={cn("mt-1.5 flex items-center gap-1.5 text-xs", pill.colorClass)}>
          <span
            className={cn(
              "size-1.5 rounded-full",
              pill.dotClass,
              pill.pulse && "animate-status-pulse",
            )}
          />
          {pill.label}
        </span>
      ) : null}
    </button>
  );
}

export const BoardCard = memo(BoardCardImpl);
