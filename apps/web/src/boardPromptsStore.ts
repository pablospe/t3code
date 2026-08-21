/**
 * User-editable prompts for the board's activating drops - the agtx
 * "phase command" idea: each workflow transition carries a configurable
 * instruction, sent verbatim as the turn's message (slash commands and
 * skill invocations included). Persisted globally per user.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type BoardTransitionPromptKey =
  | "backlogToPlanning"
  | "planningToRunning"
  | "reviewToPlanning"
  | "reviewToRunning";

export const BOARD_TRANSITION_PROMPTS: ReadonlyArray<{
  key: BoardTransitionPromptKey;
  label: string;
  detail: string;
}> = [
  {
    key: "backlogToPlanning",
    label: "Backlog → Planning",
    detail: "Starts the planning turn (native plan mode)",
  },
  {
    key: "planningToRunning",
    label: "Planning → Running",
    detail: "Starts the execution turn from an approved plan",
  },
  {
    key: "reviewToPlanning",
    label: "Review → Planning",
    detail: "Starts a re-plan turn over the thread's history (plan mode)",
  },
  {
    key: "reviewToRunning",
    label: "Review → Running",
    detail: "Resumes implementation",
  },
];

export const DEFAULT_BOARD_PROMPTS: Record<BoardTransitionPromptKey, string> = {
  backlogToPlanning:
    "Plan the task described by this thread's title. Propose a concrete plan; do not implement anything yet.",
  planningToRunning: "Proceed: implement the proposed plan.",
  reviewToPlanning:
    "Re-plan: review this thread's work and outcome so far and propose a revised plan addressing the problems or feedback. Do not implement anything yet.",
  reviewToRunning:
    "Resume: continue the implementation, completing anything unfinished and addressing any feedback raised in this thread.",
};

interface BoardPromptsState {
  prompts: Record<BoardTransitionPromptKey, string>;
  setPrompt: (key: BoardTransitionPromptKey, prompt: string) => void;
  resetPrompt: (key: BoardTransitionPromptKey) => void;
}

export const useBoardPromptsStore = create<BoardPromptsState>()(
  persist(
    (set) => ({
      prompts: { ...DEFAULT_BOARD_PROMPTS },
      setPrompt: (key, prompt) =>
        set((state) => ({ prompts: { ...state.prompts, [key]: prompt } })),
      resetPrompt: (key) =>
        set((state) => ({
          prompts: { ...state.prompts, [key]: DEFAULT_BOARD_PROMPTS[key] },
        })),
    }),
    {
      name: "t3code:board-prompts:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ prompts: state.prompts }),
      // A stored blank would silently send empty turns; fall back per key.
      merge: (persisted, current) => {
        const stored = (persisted as Partial<BoardPromptsState> | undefined)?.prompts;
        const prompts = { ...DEFAULT_BOARD_PROMPTS };
        if (stored) {
          for (const key of Object.keys(prompts) as BoardTransitionPromptKey[]) {
            const value = stored[key];
            if (typeof value === "string" && value.trim().length > 0) prompts[key] = value;
          }
        }
        return { ...current, prompts };
      },
    },
  ),
);
