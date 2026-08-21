import { PencilIcon } from "lucide-react";

import {
  BOARD_PROMPT_PRESETS,
  BOARD_TRANSITION_PROMPTS,
  DEFAULT_BOARD_PROMPTS,
  useBoardPromptsStore,
} from "~/boardPromptsStore";
import { cn } from "~/lib/utils";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

/** Editor for the four transition prompts sent by activating drops. Text is
    delivered verbatim as the turn message, so slash commands and skill
    invocations (e.g. "/openspec:plan") work. */
export function BoardPromptsEditor({ className }: { className?: string } = {}) {
  const prompts = useBoardPromptsStore((state) => state.prompts);
  const setPrompt = useBoardPromptsStore((state) => state.setPrompt);
  const resetPrompt = useBoardPromptsStore((state) => state.resetPrompt);
  const applyPreset = useBoardPromptsStore((state) => state.applyPreset);
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label="Edit drop prompts"
            title="Edit the prompts sent by drag-and-drop transitions"
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
              className,
            )}
          />
        }
      >
        <PencilIcon className="size-3.5" />
      </DialogTrigger>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Board drop prompts</DialogTitle>
          <DialogDescription>
            Sent verbatim as the turn's message when a card is dropped - slash commands and skills
            work (e.g. <span className="font-mono">/openspec:plan</span>).{" "}
            <span className="font-mono">{"{title}"}</span> is replaced with the thread's title.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Preset:</span>
            {BOARD_PROMPT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className="cursor-pointer rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {preset.label}
              </button>
            ))}
          </div>
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
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
