import { PencilIcon } from "lucide-react";

import {
  BOARD_TRANSITION_PROMPTS,
  DEFAULT_BOARD_PROMPTS,
  useBoardPromptsStore,
} from "~/boardPromptsStore";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";

/** Editor for the four transition prompts sent by activating drops. Text is
    delivered verbatim as the turn message, so slash commands and skill
    invocations (e.g. "/openspec:plan") work. */
export function BoardPromptsEditor() {
  const prompts = useBoardPromptsStore((state) => state.prompts);
  const setPrompt = useBoardPromptsStore((state) => state.setPrompt);
  const resetPrompt = useBoardPromptsStore((state) => state.resetPrompt);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Edit drop prompts"
            title="Edit the prompts sent by drag-and-drop transitions"
            className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <PencilIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" className="w-[26rem]" viewportClassName="p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Sent verbatim as the turn's message when a card is dropped - slash commands and skills
          work (e.g. <span className="font-mono">/openspec:plan</span>).
        </p>
        <div className="flex flex-col gap-3">
          {BOARD_TRANSITION_PROMPTS.map(({ key, label, detail }) => (
            <div key={key}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-foreground">{label}</span>
                {prompts[key] !== DEFAULT_BOARD_PROMPTS[key] ? (
                  <button
                    type="button"
                    onClick={() => resetPrompt(key)}
                    className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Reset
                  </button>
                ) : null}
              </div>
              <Textarea
                value={prompts[key]}
                onChange={(event) => setPrompt(key, event.target.value)}
                rows={2}
                className="text-xs"
                aria-label={`${label} prompt`}
              />
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">{detail}</p>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
