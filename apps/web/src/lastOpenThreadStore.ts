/**
 * The most recent thread route the user visited. The full-page board has no
 * open thread of its own, so it highlights this one instead - the card you
 * came from - keeping your place when you hop between a thread and /board.
 * Not persisted: "where was I" only makes sense within a session.
 */

import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface LastOpenThreadState {
  lastOpenThreadRef: ScopedThreadRef | null;
  setLastOpenThreadRef: (ref: ScopedThreadRef) => void;
}

export const useLastOpenThreadStore = create<LastOpenThreadState>()((set) => ({
  lastOpenThreadRef: null,
  setLastOpenThreadRef: (lastOpenThreadRef) => set({ lastOpenThreadRef }),
}));
