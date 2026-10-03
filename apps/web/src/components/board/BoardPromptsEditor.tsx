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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Editor for the four transition prompts sent by activating drops. Text is
    delivered verbatim as the turn message, so slash commands and skill
    invocations (e.g. "/openspec:plan") work. */
function PresetButton({
  label,
  description,
  onClick,
}: {
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="cursor-pointer rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{description}</TooltipPopup>
    </Tooltip>
  );
}

export function BoardPromptsEditor({ className }: { className?: string } = {}) {
  const prompts = useBoardPromptsStore((state) => state.prompts);
  const setPrompt = useBoardPromptsStore((state) => state.setPrompt);
  const resetPrompt = useBoardPromptsStore((state) => state.resetPrompt);
  const applyPreset = useBoardPromptsStore((state) => state.applyPreset);
  const applyDefaults = useBoardPromptsStore((state) => state.applyDefaults);
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <button
                  type="button"
                  aria-label="Edit drop prompts"
                  className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
                    className,
                  )}
                />
              }
            />
          }
        >
          <PencilIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Edit the prompts sent by drag-and-drop transitions
        </TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Board drop prompts</DialogTitle>
          <DialogDescription>
            Sent verbatim as the turn's message when a card is dropped - slash commands and skills
            work (e.g. <span className="font-mono">/openspec:plan</span>).{" "}
            <span className="font-mono">{"{title}"}</span> is replaced with the thread's title, and{" "}
            <span className="font-mono">{"{task}"}</span> with the card's task details (its title
            when it has none). A card with its own workflow uses that preset's prompts instead.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Preset:</span>
              <PresetButton
                label="Default"
                description="Restore the built-in plan → implement prompts"
                onClick={applyDefaults}
              />
              {BOARD_PROMPT_PRESETS.map((preset) => (
                <PresetButton
                  key={preset.id}
                  label={preset.label}
                  description={preset.description}
                  onClick={() => applyPreset(preset.id)}
                />
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
                      className="cursor-pointer text-3xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
                <Textarea
                  value={prompts[key]}
                  onChange={(event) => setPrompt(key, event.target.value)}
                  rows={2}
                  aria-label={`${label} prompt`}
                />
                <p className="mt-0.5 text-3xs text-muted-foreground/70">{detail}</p>
              </div>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
