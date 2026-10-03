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
import { memo, type ReactNode, useMemo, useState } from "react";

import { BOARD_PROMPT_PRESETS } from "~/boardPromptsStore";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarThreadSummary } from "~/types";

import { resolveThreadStatusPill } from "../Sidebar.logic";
import { resolveSnoozePresets, snoozeWakeDescription, type SnoozePreset } from "../Sidebar.snooze";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type BoardColumnKey, isThreadSnoozed } from "./boardColumns.logic";
import { BoardCardTooltip } from "./BoardCardTooltip";

export interface BoardCardDragData {
  readonly threadId: SidebarThreadSummary["id"];
  readonly environmentId: SidebarThreadSummary["environmentId"];
  readonly column: BoardColumnKey;
}

const CARD_FRAME_CLASS = "w-full rounded-lg border border-border bg-card px-3 py-2 text-left";

const ACTION_BUTTON_CLASS =
  "flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";

/** An icon action with the app's tooltip. Clicks stop at the button so they
    never open the card underneath. */
export function BoardActionButton({
  label,
  ariaLabel = label,
  className,
  onClick,
  children,
}: {
  label: string;
  ariaLabel?: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            className={cn(ACTION_BUTTON_CLASS, className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The first candidate that parses as a date, kept as its ISO string for
    formatRelativeTimeLabel. */
function firstValidIsoTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate != null && !Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/** A per-task workflow is worth naming in the details tooltip: it changes
    what every drop on this card sends. */
function presetLabelPrefix(presetId: string | null | undefined): string {
  if (!presetId) return "";
  const preset = BOARD_PROMPT_PRESETS.find((candidate) => candidate.id === presetId);
  return preset ? `[${preset.label}] ` : "";
}

function BoardCardBody({
  thread,
  projectTitle,
  snoozedWakeLabel = null,
  onEditTask = null,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
  /** When set, the card is snoozed: the status pill yields to a wake label. */
  snoozedWakeLabel?: string | null;
  /** Interactive cards on servers with task fields pass this: the details
      icon becomes an edit button (dimmed while the card has no details). The
      drag preview passes nothing and keeps a passive icon. */
  onEditTask?: (() => void) | null;
}) {
  const pill = resolveThreadStatusPill({ thread });
  const activityAt = firstValidIsoTimestamp(
    thread.latestUserMessageAt,
    thread.updatedAt,
    thread.createdAt,
  );
  // Only a pinned preset earns a chip: Default follows the board-wide
  // prompts, so labeling it on every card would be noise, not signal.
  const workflowLabel =
    BOARD_PROMPT_PRESETS.find((preset) => preset.id === thread.workflowPreset)?.label ?? null;
  // Task details can run long, so the card reveals them on hover rather than
  // spending card height on text the board does not need to read.
  const detailsText = thread.taskDetails
    ? `${presetLabelPrefix(thread.workflowPreset)}${thread.taskDetails}`
    : null;
  return (
    <>
      <span className="block truncate pr-12 text-sm font-medium text-foreground">
        {thread.title}
      </span>
      <span
        className={cn(
          "mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/70",
          // The selected card's lighter fill washes out the default grey;
          // restore contrast on the card you are actually looking at.
          "group-aria-[current=true]/board-card:text-muted-foreground",
        )}
      >
        {/* The branch shrinks four times faster than the project: the project
            name disambiguates environments, so it wins the width fight. */}
        <span className="truncate">{projectTitle}</span>
        {thread.branch ? (
          <span className="min-w-0 shrink-[4] truncate">{thread.branch}</span>
        ) : null}
        {onEditTask !== null ? (
          <BoardActionButton
            label={detailsText ?? "Add task details"}
            ariaLabel="Edit task details"
            className={cn("size-auto p-0.5", detailsText === null && "opacity-40")}
            onClick={onEditTask}
          >
            <FileTextIcon className="size-3" />
          </BoardActionButton>
        ) : detailsText !== null ? (
          <FileTextIcon className="size-3 shrink-0" aria-label="Has task details" />
        ) : null}
        {workflowLabel !== null ? (
          <span className="shrink-0 rounded bg-accent px-1 text-3xs leading-4 text-muted-foreground">
            {workflowLabel}
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
  selected = false,
  onOpen,
  onSettle,
  onUnsettle,
  onArchive,
  onDelete,
  onSnooze,
  onUnsnooze,
  onContextMenu,
  onEditTask,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string;
  column: BoardColumnKey;
  now: number;
  /** The thread open in the main view, highlighted like the sidebar row. */
  selected?: boolean;
  onOpen: (thread: SidebarThreadSummary) => void;
  onSettle: (thread: SidebarThreadSummary) => void;
  onUnsettle: (thread: SidebarThreadSummary) => void;
  onArchive: (thread: SidebarThreadSummary) => void;
  onDelete: (thread: SidebarThreadSummary) => void;
  onSnooze: (thread: SidebarThreadSummary, preset: SnoozePreset) => void;
  onUnsnooze: (thread: SidebarThreadSummary) => void;
  onContextMenu: (thread: SidebarThreadSummary, position: { x: number; y: number }) => void;
  /** Null when the thread's server predates task fields: the details icon
      stays a passive indicator instead of a dead edit button. */
  onEditTask: ((thread: SidebarThreadSummary) => void) | null;
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

  // The card shares the sidebar row's hover card: the draggable card root is
  // the tooltip trigger (base-ui merges the refs and pointer handlers), and
  // BoardCardTooltip feeds the same popup the sidebar renders.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={setNodeRef}
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
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
              "group/board-card relative transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              // The open thread's card reproduces the sidebar row's exact paint:
              // its selected token is translucent, so matching the row means
              // compositing it over the sidebar's own background, not the card's
              // lighter surface - hence the two gradient layers. The quiet
              // ring-color border keeps selection legible in themes where that
              // composite matches the card (default light theme: both white).
              // Everything else lights on hover only.
              selected
                ? "border-ring/40 [background-image:linear-gradient(var(--sidebar-row-selected),var(--sidebar-row-selected)),linear-gradient(var(--sidebar),var(--sidebar))]"
                : "hover:bg-accent/60",
              // Offscreen cards skip style, layout and paint; a tall column costs
              // what the viewport shows. The intrinsic size keeps scrolling honest.
              // 88px tracks a card's real rendered height (title + meta row +
              // status row + padding + border); understating it makes long
              // columns' scrollbars drift as offscreen cards materialize.
              "[contain-intrinsic-block-size:88px] [content-visibility:auto]",
              // Snoozed cards recede like disabled controls but stay interactive;
              // hover restores enough contrast to read and act on them.
              snoozed && "opacity-50 hover:opacity-90",
              isDragging && "opacity-40",
            )}
          />
        }
      >
        <BoardCardBody
          thread={thread}
          projectTitle={projectTitle}
          snoozedWakeLabel={snoozedWakeLabel}
          onEditTask={onEditTask ? () => onEditTask(thread) : null}
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
              <BoardActionButton
                label="Unsettle"
                ariaLabel="Unsettle thread"
                onClick={() => onUnsettle(thread)}
              >
                <Undo2Icon className="size-3.5" />
              </BoardActionButton>
              <BoardActionButton
                label="Archive"
                ariaLabel="Archive thread"
                onClick={() => onArchive(thread)}
              >
                <ArchiveIcon className="size-3.5" />
              </BoardActionButton>
              <BoardActionButton
                label="Delete"
                ariaLabel="Delete thread"
                className="hover:text-error"
                onClick={() => onDelete(thread)}
              >
                <Trash2Icon className="size-3.5" />
              </BoardActionButton>
            </>
          ) : snoozed ? (
            <>
              <BoardActionButton
                label="Unsnooze"
                ariaLabel="Unsnooze thread"
                onClick={() => onUnsnooze(thread)}
              >
                <AlarmClockOffIcon className="size-3.5" />
              </BoardActionButton>
              <BoardActionButton
                label="Settle"
                ariaLabel="Settle thread"
                onClick={() => onSettle(thread)}
              >
                <CheckIcon className="size-3.5" />
              </BoardActionButton>
            </>
          ) : (
            <>
              <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <PopoverTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Snooze thread"
                            onClick={(event) => event.stopPropagation()}
                            className={ACTION_BUTTON_CLASS}
                          />
                        }
                      />
                    }
                  >
                    <ClockIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Snooze</TooltipPopup>
                </Tooltip>
                <PopoverPopup side="bottom" align="end" width="sm" padding="compact">
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
                      <span className="font-mono text-3xs text-muted-foreground/60 tabular-nums">
                        {preset.whenLabel}
                      </span>
                    </button>
                  ))}
                </PopoverPopup>
              </Popover>
              <BoardActionButton
                label="Settle"
                ariaLabel="Settle thread"
                onClick={() => onSettle(thread)}
              >
                <CheckIcon className="size-3.5" />
              </BoardActionButton>
            </>
          )}
        </span>
      </TooltipTrigger>
      <BoardCardTooltip thread={thread} projectTitle={projectTitle} />
    </Tooltip>
  );
}

export const BoardCard = memo(BoardCardImpl);
