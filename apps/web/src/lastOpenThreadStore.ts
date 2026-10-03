/**
 * The most recent thread route the user visited. The full-page board has no
 * open thread of its own, so it highlights this one instead - the card you
 * came from - keeping your place when you hop between a thread and /board.
 * Persisted per tab (sessionStorage) so a reload on /board keeps the
 * highlight; a new tab starts clean, where "where was I" has no answer.
 */

import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface LastOpenThreadState {
  lastOpenThreadRef: ScopedThreadRef | null;
  setLastOpenThreadRef: (ref: ScopedThreadRef) => void;
}

export const useLastOpenThreadStore = create<LastOpenThreadState>()(
  persist(
    (set) => ({
      lastOpenThreadRef: null,
      setLastOpenThreadRef: (lastOpenThreadRef) => set({ lastOpenThreadRef }),
    }),
    {
      name: "t3code:last-open-thread:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.sessionStorage : undefined),
      ),
    },
  ),
);
