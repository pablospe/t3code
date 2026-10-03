import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import type { SidebarThreadSummary } from "../../types";

/** A backlog thread carries its queued task details, so opening it seeds the
    composer and the queued prompt is one Send away. Only before the first run,
    never over typed content, and once per visit so a composer the user cleared
    stays cleared. */
export function useSeedComposerFromTaskDetails(input: {
  readonly threadShell: Pick<SidebarThreadSummary, "taskDetails" | "latestRun"> | null;
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly enabled: boolean;
}) {
  const { threadKey, threadRef, enabled } = input;
  const details = input.threadShell?.taskDetails?.trim() ?? "";
  const unstarted = input.threadShell?.latestRun === null;
  const seededThreadKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !unstarted || details === "") return;
    if (seededThreadKey.current === threadKey) return;
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(threadRef);
    if (draft && draft.prompt.trim() !== "") return;
    store.setPrompt(threadRef, details);
    seededThreadKey.current = threadKey;
  }, [enabled, unstarted, details, threadKey, threadRef]);
}
