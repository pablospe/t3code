import { useEffect, useRef } from "react";

import type { EnvironmentThreadShell, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";

/** A backlog thread carries its queued task details, so opening it seeds the
    composer and the queued prompt is one Send away. Only before the first turn,
    never over typed content, and once per visit so a composer the user cleared
    stays cleared. */
export function useSeedComposerFromTaskDetails(input: {
  readonly threadShell: EnvironmentThreadShell | null;
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly enabled: boolean;
}) {
  const { threadShell, threadKey, threadRef, enabled } = input;
  const seededThreadKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !threadShell) return;
    if (seededThreadKey.current === threadKey) return;
    const details = threadShell.taskDetails?.trim();
    if (!details || threadShell.latestTurn !== null) return;
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(threadRef);
    if (draft && draft.prompt.trim() !== "") return;
    store.setPrompt(threadRef, details);
    seededThreadKey.current = threadKey;
  }, [enabled, threadShell, threadKey, threadRef]);
}
