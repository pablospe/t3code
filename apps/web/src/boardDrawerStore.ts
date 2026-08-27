/**
 * Global (not per-thread) UI state for the board drawer: the kanban board is a
 * cross-project surface, so one open/height pair follows the user across
 * thread switches, unlike the per-thread terminal and right-panel stores.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const BOARD_DRAWER_MIN_HEIGHT = 220;
export const BOARD_DRAWER_MAX_HEIGHT_RATIO = 0.75;
const DEFAULT_BOARD_DRAWER_HEIGHT = 320;

export function clampBoardDrawerHeight(height: number): number {
  const max =
    typeof window === "undefined"
      ? Number.POSITIVE_INFINITY
      : Math.floor(window.innerHeight * BOARD_DRAWER_MAX_HEIGHT_RATIO);
  return Math.min(Math.max(height, BOARD_DRAWER_MIN_HEIGHT), max);
}

interface BoardDrawerState {
  open: boolean;
  height: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setHeight: (height: number) => void;
}

export const useBoardDrawerStore = create<BoardDrawerState>()(
  persist(
    (set) => ({
      open: false,
      height: DEFAULT_BOARD_DRAWER_HEIGHT,
      setOpen: (open) => set({ open }),
      toggle: () => set((state) => ({ open: !state.open })),
      setHeight: (height) => set({ height: clampBoardDrawerHeight(height) }),
    }),
    {
      name: "t3code:board-drawer:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ open: state.open, height: state.height }),
    },
  ),
);
