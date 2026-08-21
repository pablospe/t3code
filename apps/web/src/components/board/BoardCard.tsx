import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CheckIcon, ClockIcon, Undo2Icon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarThreadSummary } from "~/types";

import { firstValidTimestamp, resolveThreadStatusPill } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { BoardColumnKey } from "./boardColumns.logic";

export interface BoardCardDragData {
  readonly threadId: SidebarThreadSummary["id"];
  readonly environmentId: SidebarThreadSummary["environmentId"];
  readonly column: BoardColumnKey;
}

const ACTION_BUTTON_CLASS =
  "flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";

function BoardCardImpl({
  thread,
  projectTitle,
  column,
  onOpen,
  onSettle,
  onUnsettle,
  onSnooze,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
  column: BoardColumnKey;
  onOpen: (thread: SidebarThreadSummary) => void;
  onSettle: (thread: SidebarThreadSummary) => void;
  onUnsettle: (thread: SidebarThreadSummary) => void;
  onSnooze: (thread: SidebarThreadSummary, preset: SnoozePreset) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  // Presets resolve at open time so "In 1 hour" is relative to the click.
  const snoozePresets = useMemo(
    () => (snoozeOpen ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [snoozeOpen, timestampFormat],
  );

  const dragData: BoardCardDragData = {
    threadId: thread.id,
    environmentId: thread.environmentId,
    column,
  };
  // dnd-kit's aria attributes are deliberately not spread, matching the
  // sidebar's pinned-reorder convention; the card carries its own role.
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({
    id: `${thread.environmentId}:${thread.id}`,
    data: dragData,
  });

  const pill = resolveThreadStatusPill({ thread });
  const activityAt = firstValidTimestamp(
    thread.latestUserMessageAt,
    thread.updatedAt,
    thread.createdAt,
  );
  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(thread)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) onOpen(thread);
      }}
      style={{ transform: CSS.Translate.toString(transform) }}
      {...listeners}
      className={cn(
        "group/board-card relative w-full rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        // Offscreen cards skip style, layout and paint; a tall column costs
        // what the viewport shows. The intrinsic size keeps scrolling honest.
        "[contain-intrinsic-block-size:72px] [content-visibility:auto]",
        isDragging && "z-20 opacity-80",
      )}
    >
      <span className="block truncate pr-12 text-sm font-medium text-foreground">
        {thread.title}
      </span>
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
      <span
        className={cn(
          "absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-card/90 opacity-0 transition-opacity",
          "group-hover/board-card:opacity-100 has-[:focus-visible]:opacity-100",
          snoozeOpen && "opacity-100",
        )}
      >
        {column === "done" ? (
          <button
            type="button"
            aria-label="Unsettle thread"
            title="Unsettle"
            onClick={(event) => {
              event.stopPropagation();
              onUnsettle(thread);
            }}
            className={ACTION_BUTTON_CLASS}
          >
            <Undo2Icon className="size-3.5" />
          </button>
        ) : (
          <>
            <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label="Snooze thread"
                    title="Snooze"
                    onClick={(event) => event.stopPropagation()}
                    className={ACTION_BUTTON_CLASS}
                  />
                }
              >
                <ClockIcon className="size-3.5" />
              </PopoverTrigger>
              <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
                {snoozePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSnoozeOpen(false);
                      onSnooze(thread, preset);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
                  >
                    <span className="flex-1">{preset.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                      {preset.whenLabel}
                    </span>
                  </button>
                ))}
              </PopoverPopup>
            </Popover>
            <button
              type="button"
              aria-label="Settle thread"
              title="Settle"
              onClick={(event) => {
                event.stopPropagation();
                onSettle(thread);
              }}
              className={ACTION_BUTTON_CLASS}
            >
              <CheckIcon className="size-3.5" />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

export const BoardCard = memo(BoardCardImpl);
