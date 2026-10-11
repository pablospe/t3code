/**
 * How lists show a thread that mirrors a terminal session waiting for its user
 * there. Kept out of Sidebar.tsx and Sidebar.logic.ts so they only call in.
 */
import type { SidebarThreadSummary } from "../types";
import type { ThreadStatusPill } from "./Sidebar.logic";

type ExternalSessionWaiting = NonNullable<SidebarThreadSummary["externalSessionWaiting"]>;

/** The status pill, with the reason ("permission prompt") on hover. */
export function terminalStatusPill(waiting: ExternalSessionWaiting): ThreadStatusPill {
  return {
    label: "Waiting in terminal",
    colorClass: "text-indigo-600 dark:text-indigo-300/90",
    dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
    pulse: false,
    ...(waiting.reason === null ? {} : { tooltip: `Waiting in terminal: ${waiting.reason}` }),
  };
}

/**
 * The sidebar row's status. The reason is on the thread's status line; the row
 * status gives way to row controls on hover, so it has no tooltip.
 */
export const TERMINAL_ROW_STATUS = {
  label: "Waiting in terminal",
  icon: "terminal" as const,
  className: "text-indigo-600 dark:text-indigo-300",
};

/**
 * Notification key and title for a terminal session waiting for its user. The
 * key is constant, so one alert fires on entering waiting and none while it
 * keeps waiting, even if the reason changes.
 */
export const TERMINAL_ATTENTION = "terminal";
export function terminalNotificationTitle(waiting: ExternalSessionWaiting | null): string {
  return waiting?.reason ? `Waiting in terminal: ${waiting.reason}` : "Waiting in terminal";
}
