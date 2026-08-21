import { useDraggable } from "@dnd-kit/core";
import {
  AlarmClockOffIcon,
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { BOARD_PROMPT_PRESETS } from "~/boardPromptsStore";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarThreadSummary } from "~/types";

import { firstValidTimestamp, resolveThreadStatusPill } from "../Sidebar.logic";
import { resolveSnoozePresets, snoozeWakeDescription, type SnoozePreset } from "../Sidebar.snooze";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { type BoardColumnKey, isThreadSnoozed } from "./boardColumns.logic";

export interface BoardCardDragData {
  readonly threadId: SidebarThreadSummary["id"];
  readonly environmentId: SidebarThreadSummary["environmentId"];
  readonly column: BoardColumnKey;
}

const CARD_FRAME_CLASS = "w-full rounded-lg border border-border bg-card px-3 py-2 text-left";

const ACTION_BUTTON_CLASS =
  "flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";

/** A per-task workflow is worth naming in the tooltip: it changes what every
    drop on this card sends. */
function presetLabelPrefix(presetId: string | null | undefined): string {
  if (!presetId) return "";
  const preset = BOARD_PROMPT_PRESETS.find((candidate) => candidate.id === presetId);
  return preset ? `[${preset.label}] ` : "";
}

function BoardCardBody({
  thread,
  projectTitle,
  snoozedWakeLabel = null,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
  /** When set, the card is snoozed: the status pill yields to a wake label. */
  snoozedWakeLabel?: string | null;
}) {
  const pill = resolveThreadStatusPill({ thread });
  const activityAt = firstValidTimestamp(
    thread.latestUserMessageAt,
    thread.updatedAt,
    thread.createdAt,
  );
  // Task details can run long, so the card reveals them on hover rather than
  // spending card height on text the board does not need to read.
  const detailsTooltip = thread.taskDetails
    ? `${presetLabelPrefix(thread.workflowPreset)}${thread.taskDetails}`
    : null;
  return (
    <>
      <span className="block truncate pr-12 text-sm font-medium text-foreground">
        {thread.title}
      </span>
      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/70">
        <span className="truncate">{projectTitle}</span>
        {thread.branch ? <span className="truncate">{thread.branch}</span> : null}
        {detailsTooltip !== null ? (
          // The tooltip rides a span: a title attribute on an svg does not
          // surface natively.
          <span className="flex shrink-0 items-center" title={detailsTooltip}>
            <FileTextIcon className="size-3" aria-label="Has task details" />
          </span>
        ) : null}
        {activityAt ? (
          <span className="ml-auto shrink-0">{formatRelativeTimeLabel(activityAt)}</span>
        ) : null}
      </span>
      {snoozedWakeLabel !== null ? (
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ClockIcon className="size-3" />
          {`Snoozed until ${snoozedWakeLabel}`}
        </span>
      ) : pill ? (
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
    </>
  );
}

/** Rendered inside DragOverlay: a portal-level copy of the dragged card, so it
    floats above every column instead of being clipped by its own lane. */
export function BoardCardPreview({
  thread,
  projectTitle,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
}) {
  return (
    <div className={cn(CARD_FRAME_CLASS, "w-64 shadow-lg")}>
      <BoardCardBody thread={thread} projectTitle={projectTitle} />
    </div>
  );
}

function BoardCardImpl({
  thread,
  projectTitle,
  column,
  now,
  onOpen,
  onSettle,
  onUnsettle,
  onArchive,
  onDelete,
  onSnooze,
  onUnsnooze,
  onContextMenu,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
  column: BoardColumnKey;
  now: number;
  onOpen: (thread: SidebarThreadSummary) => void;
  onSettle: (thread: SidebarThreadSummary) => void;
  onUnsettle: (thread: SidebarThreadSummary) => void;
  onArchive: (thread: SidebarThreadSummary) => void;
  onDelete: (thread: SidebarThreadSummary) => void;
  onSnooze: (thread: SidebarThreadSummary, preset: SnoozePreset) => void;
  onUnsnooze: (thread: SidebarThreadSummary) => void;
  onContextMenu: (thread: SidebarThreadSummary, position: { x: number; y: number }) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const snoozed = isThreadSnoozed(thread, now);
  const snoozedWakeLabel =
    snoozed && thread.snoozedUntil != null
      ? snoozeWakeDescription(thread.snoozedUntil, new Date(now), timestampFormat)
      : null;
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
  // sidebar's pinned-reorder convention; the card carries its own role. The
  // dragged visual is a DragOverlay copy, so the source card stays in place,
  // dimmed, rather than being transformed inside its clipping column.
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${thread.environmentId}:${thread.id}`,
    data: dragData,
  });

  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(thread)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) onOpen(thread);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(thread, { x: event.clientX, y: event.clientY });
      }}
      {...listeners}
      className={cn(
        CARD_FRAME_CLASS,
        "group/board-card relative transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        // Offscreen cards skip style, layout and paint; a tall column costs
        // what the viewport shows. The intrinsic size keeps scrolling honest.
        "[contain-intrinsic-block-size:72px] [content-visibility:auto]",
        // Snoozed cards recede like disabled controls but stay interactive;
        // hover restores enough contrast to read and act on them.
        snoozed && "opacity-50 hover:opacity-90",
        isDragging && "opacity-40",
      )}
    >
      <BoardCardBody
        thread={thread}
        projectTitle={projectTitle}
        snoozedWakeLabel={snoozedWakeLabel}
      />
      <span
        className={cn(
          "absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-card/90 opacity-0 transition-opacity",
          "group-hover/board-card:opacity-100 has-[:focus-visible]:opacity-100",
          snoozeOpen && "opacity-100",
        )}
      >
        {column === "done" ? (
          <>
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
            <button
              type="button"
              aria-label="Archive thread"
              title="Archive"
              onClick={(event) => {
                event.stopPropagation();
                onArchive(thread);
              }}
              className={ACTION_BUTTON_CLASS}
            >
              <ArchiveIcon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete thread"
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(thread);
              }}
              className={cn(ACTION_BUTTON_CLASS, "hover:text-error")}
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </>
        ) : snoozed ? (
          <>
            <button
              type="button"
              aria-label="Unsnooze thread"
              title="Unsnooze"
              onClick={(event) => {
                event.stopPropagation();
                onUnsnooze(thread);
              }}
              className={ACTION_BUTTON_CLASS}
            >
              <AlarmClockOffIcon className="size-3.5" />
            </button>
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
