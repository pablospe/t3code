import { useCallback, useRef } from "react";

import { clampBoardDrawerHeight, useBoardDrawerStore } from "~/boardDrawerStore";

import { BoardContent } from "./BoardContent";

/** Global top drawer hosting the board, docked between the chat header and
    the conversation. Open state and height live in a global store, so the
    drawer follows the user across thread switches - clicking a card
    navigates the main view while the drawer stays put. */
export function BoardDrawer() {
  const open = useBoardDrawerStore((state) => state.open);
  const height = useBoardDrawerStore((state) => state.height);
  const setHeight = useBoardDrawerStore((state) => state.setHeight);
  const dragStateRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(
    null,
  );

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: height,
      };
    },
    [height],
  );

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      // The drawer sits at the top: dragging the strip down grows it.
      setHeight(clampBoardDrawerHeight(dragState.startHeight + (event.clientY - dragState.startY)));
    },
    [setHeight],
  );

  const handleResizePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
    }
  }, []);

  if (!open) return null;

  return (
    <aside
      aria-label="Board drawer"
      style={{ height: `${height}px` }}
      className="relative shrink-0 border-b border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        className="absolute inset-x-0 bottom-0 z-10 h-1.5 cursor-row-resize"
      />
      <div className="h-full min-h-0">
        <BoardContent compact />
      </div>
    </aside>
  );
}
