import { useEffect, useState } from "react";

import { BOARD_PROMPT_PRESETS } from "~/boardPromptsStore";

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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface BoardBacklogTaskDraft {
  title: string;
  /** Optional full task text, delivered as "{task}" when planning starts. */
  details: string;
  /** A BOARD_PROMPT_PRESETS id, or null to follow the board-wide prompts. */
  presetId: string | null;
}

/** Select items cannot carry null, so the no-preset choice gets a sentinel.
    "Default" here means no pinned preset: the task follows the board-wide
    prompts (plain plan → implement unless customized in the pencil editor). */
const DEFAULT_WORKFLOW_VALUE = "__default__";

const WORKFLOW_OPTIONS: ReadonlyArray<{ value: string; label: string; description: string }> = [
  {
    value: DEFAULT_WORKFLOW_VALUE,
    label: "Default",
    description: "Follows the board-wide prompts (editable via the pencil on the board).",
  },
  ...BOARD_PROMPT_PRESETS.map(({ id, label, description }) => ({ value: id, label, description })),
];

/** Creates or edits a board task. Create makes a card that sits in Backlog:
    the thread exists server-side from the moment it is named, but no turn
    starts until it is dragged out. Edit (opened from a card's details icon)
    reuses the same form seeded with the thread's current task fields. Details
    and workflow persist on the thread itself (taskDetails / workflowPreset),
    so every client sees the same card. */
export function BoardBacklogDialog({
  open,
  onOpenChange,
  projectTitle,
  modelAvailable,
  initial = null,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectTitle: string | null;
  modelAvailable: boolean;
  /** When set, the dialog edits this task instead of creating one. */
  initial?: BoardBacklogTaskDraft | null;
  onSubmit: (task: BoardBacklogTaskDraft) => void;
}) {
  const editing = initial !== null;
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);
  // Seed on every open: blank for create (a dialog that reopens holding the
  // last task reads as a stuck form), the thread's current fields for edit.
  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setDetails(initial?.details ?? "");
    setPresetId(initial?.presetId ?? null);
  }, [open, initial]);
  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && (editing || modelAvailable);
  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ title: trimmed, details: details.trim(), presetId });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit task" : "New backlog task"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes save to the thread itself, so every client sees them."
              : modelAvailable
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
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Workflow:</span>
                <Select
                  modal={false}
                  value={presetId ?? DEFAULT_WORKFLOW_VALUE}
                  onValueChange={(value: string | null) =>
                    setPresetId(value === DEFAULT_WORKFLOW_VALUE ? null : value)
                  }
                  items={WORKFLOW_OPTIONS}
                >
                  <SelectTrigger size="xs" aria-label="Workflow">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {WORKFLOW_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {
                  WORKFLOW_OPTIONS.find(
                    (option) => option.value === (presetId ?? DEFAULT_WORKFLOW_VALUE),
                  )?.description
                }
              </p>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
