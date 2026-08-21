/**
 * Per-task metadata for board cards - agtx's plugin-per-task idea trimmed to
 * what T3 needs: the full task text a card carries into its planning turn, and
 * an optional workflow preset that overrides the board-wide drop prompts.
 *
 * Client-local by design: T3 has no server-side queued-message concept, so a
 * task's details exist only on the device that wrote them.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { BOARD_PROMPT_PRESETS, type BoardTransitionPromptKey } from "./boardPromptsStore";
import { resolveStorage } from "./lib/storage";

export interface BoardTaskMeta {
  /** Fills the "{task}" placeholder; the title is the fallback. */
  details?: string | undefined;
  /** A BOARD_PROMPT_PRESETS id, or undefined to follow the global prompts. */
  presetId?: string | undefined;
}

export const boardTaskMetaKey = (environmentId: string, threadId: string): string =>
  `${environmentId}:${threadId}`;

/** A task's own preset wins over the board-wide prompts; an id that no longer
    resolves (preset removed since it was chosen) falls back to global. */
export function resolvePromptsForThread(
  meta: BoardTaskMeta | undefined,
  globalPrompts: Record<BoardTransitionPromptKey, string>,
): Record<BoardTransitionPromptKey, string> {
  if (!meta?.presetId) return globalPrompts;
  return (
    BOARD_PROMPT_PRESETS.find((preset) => preset.id === meta.presetId)?.prompts ?? globalPrompts
  );
}

interface BoardTaskMetaState {
  metaByThreadKey: Record<string, BoardTaskMeta>;
  setTaskMeta: (threadKey: string, meta: BoardTaskMeta) => void;
  clearTaskMeta: (threadKey: string) => void;
}

export const useBoardTaskMetaStore = create<BoardTaskMetaState>()(
  persist(
    (set) => ({
      metaByThreadKey: {},
      setTaskMeta: (threadKey, meta) =>
        set((state) => {
          const merged = { ...state.metaByThreadKey[threadKey], ...meta };
          const details = merged.details?.trim() ? merged.details : undefined;
          const presetId = merged.presetId ? merged.presetId : undefined;
          // An entry holding nothing is just dead storage: drop it instead.
          if (details === undefined && presetId === undefined) {
            if (!(threadKey in state.metaByThreadKey)) return state;
            const { [threadKey]: _removed, ...metaByThreadKey } = state.metaByThreadKey;
            return { metaByThreadKey };
          }
          return {
            metaByThreadKey: { ...state.metaByThreadKey, [threadKey]: { details, presetId } },
          };
        }),
      clearTaskMeta: (threadKey) =>
        set((state) => {
          if (!(threadKey in state.metaByThreadKey)) return state;
          const { [threadKey]: _removed, ...metaByThreadKey } = state.metaByThreadKey;
          return { metaByThreadKey };
        }),
    }),
    {
      name: "t3code:board-task-meta:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ metaByThreadKey: state.metaByThreadKey }),
    },
  ),
);
