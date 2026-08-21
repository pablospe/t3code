import { useState } from "react";

import { BOARD_PROMPT_PRESETS } from "~/boardPromptsStore";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export interface BoardBacklogTaskDraft {
  title: string;
  /** Optional full task text, delivered as "{task}" when planning starts. */
  details: string;
  /** A BOARD_PROMPT_PRESETS id, or null to follow the board-wide prompts. */
  presetId: string | null;
}

const WORKFLOW_BUTTON_CLASS = "cursor-pointer rounded px-2 py-1 text-xs";

/** "Global prompts" is the absence of a per-task preset, not a preset itself. */
const WORKFLOW_OPTIONS: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: null, label: "Global prompts" },
  ...BOARD_PROMPT_PRESETS.map(({ id, label }) => ({ id, label })),
];

/** Creates a card that sits in Backlog: the thread exists server-side from
    the moment it is named, but no turn starts until it is dragged out. Details
    and workflow persist on the thread itself (taskDetails / workflowPreset), so
    every client sees the same card. */
export function BoardBacklogDialog({
  open,
  onOpenChange,
  projectTitle,
  modelAvailable,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectTitle: string | null;
  modelAvailable: boolean;
  onCreate: (task: BoardBacklogTaskDraft) => void;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);
  const trimmed = title.trim();
  const canCreate = trimmed.length > 0 && modelAvailable;
  const submit = () => {
    if (!canCreate) return;
    onCreate({ title: trimmed, details: details.trim(), presetId });
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A dialog that reopens holding the last task reads as a stuck form.
        if (next) {
          setTitle("");
          setDetails("");
          setPresetId(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New backlog task</DialogTitle>
          <DialogDescription>
            {modelAvailable
              ? `Created in ${projectTitle ?? "the default project"} - it stays in Backlog until started; drag to Planning starts planning it.`
              : "No model available - start any thread once first."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              aria-label="Task title"
            />
            <Textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              rows={4}
              placeholder="Full task description delivered when planning starts (optional)"
              aria-label="Task details"
              className="text-sm"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Workflow:</span>
              {WORKFLOW_OPTIONS.map((option) => (
                <button
                  key={option.id ?? "global"}
                  type="button"
                  onClick={() => setPresetId(option.id)}
                  aria-pressed={presetId === option.id}
                  className={cn(
                    WORKFLOW_BUTTON_CLASS,
                    presetId === option.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={!canCreate} onClick={submit}>
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
