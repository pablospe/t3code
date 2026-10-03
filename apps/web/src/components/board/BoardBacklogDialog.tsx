import { type ModelSelection, THREAD_TASK_DETAILS_MAX_LENGTH } from "@t3tools/contracts";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface BoardBacklogTaskDraft {
  title: string;
  /** Optional full task text, delivered as "{task}" when planning starts. */
  details: string;
  /** A BOARD_PROMPT_PRESETS id, or null to follow the board-wide prompts. */
  presetId: string | null;
  /** The chosen project's key; null when editing an existing task. */
  projectKey: string | null;
}

/** A project a new task can be created in. */
export interface BoardTaskProjectChoice {
  readonly key: string;
  readonly label: string;
  /** Null when no model is known for it yet; such a project cannot take a task. */
  readonly modelSelection: ModelSelection | null;
  readonly taskFieldsSupported: boolean;
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
    the thread exists server-side from the moment it is named, but no run
    starts until it is dragged out. Edit (opened from a card's details icon)
    reuses the same form seeded with the thread's current task fields. Details
    and workflow persist on the thread itself (taskDetails / workflowPreset),
    so every client sees the same card. */
export function BoardBacklogDialog({
  open,
  onOpenChange,
  projectChoices,
  editTaskFieldsSupported,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where a new task may go. One choice is used as is; several need an
      explicit pick, so a task never lands in a project nobody chose. */
  projectChoices: ReadonlyArray<BoardTaskProjectChoice>;
  /** Edit mode: whether the task's server persists details and workflow. */
  editTaskFieldsSupported: boolean;
  /** When set, the dialog edits this task instead of creating one. */
  initial: Omit<BoardBacklogTaskDraft, "projectKey"> | null;
  onSubmit: (task: BoardBacklogTaskDraft) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        {/* Mounted per open, so the form seeds from `initial` each time: blank
            for create (a reopened form holding the last task reads as stuck),
            the thread's current fields for edit. */}
        <BoardTaskForm
          projectChoices={projectChoices}
          editTaskFieldsSupported={editTaskFieldsSupported}
          initial={initial}
          onSubmit={(task) => {
            onSubmit(task);
            onOpenChange(false);
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}

const NO_PROJECT_VALUE = "__none__";

function BoardTaskForm({
  projectChoices,
  editTaskFieldsSupported,
  initial,
  onSubmit,
}: {
  projectChoices: ReadonlyArray<BoardTaskProjectChoice>;
  editTaskFieldsSupported: boolean;
  initial: Omit<BoardBacklogTaskDraft, "projectKey"> | null;
  onSubmit: (task: BoardBacklogTaskDraft) => void;
}) {
  const editing = initial !== null;
  const soleChoice = projectChoices.length === 1 ? (projectChoices[0] ?? null) : null;
  const [pickedProjectKey, setPickedProjectKey] = useState<string | null>(null);
  const project =
    soleChoice ?? projectChoices.find((choice) => choice.key === pickedProjectKey) ?? null;
  const modelAvailable = project !== null && project.modelSelection !== null;
  // Until a project is picked, show the task fields only if every candidate
  // can keep them, so nothing typed is dropped by the server chosen later.
  const taskFieldsSupported = editing
    ? editTaskFieldsSupported
    : project
      ? project.taskFieldsSupported
      : projectChoices.every((choice) => choice.taskFieldsSupported);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [details, setDetails] = useState(initial?.details ?? "");
  const [presetId, setPresetId] = useState<string | null>(initial?.presetId ?? null);
  const trimmed = title.trim();
  // The server rejects longer details, so Save waits until they fit.
  const detailsLength = details.trim().length;
  const detailsTooLong = taskFieldsSupported && detailsLength > THREAD_TASK_DETAILS_MAX_LENGTH;
  const canSubmit = trimmed.length > 0 && (editing || modelAvailable) && !detailsTooLong;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      title: trimmed,
      details: details.trim(),
      presetId,
      projectKey: editing ? null : (project?.key ?? null),
    });
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit task" : "New backlog task"}</DialogTitle>
        <DialogDescription>
          {editing
            ? "Changes save to the thread itself, so every client sees them."
            : projectChoices.length === 0
              ? "No project to create the task in yet."
              : project === null
                ? "Pick the project it belongs to - it stays in Backlog until started; drag to Planning starts planning it."
                : modelAvailable
                  ? `Created in ${project.label} - it stays in Backlog until started; drag to Planning starts planning it.`
                  : `No model known for ${project.label} - start a thread there once first.`}
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
          {!editing && soleChoice === null && projectChoices.length > 0 ? (
            <Select
              modal={false}
              value={pickedProjectKey ?? NO_PROJECT_VALUE}
              onValueChange={(value: string | null) =>
                setPickedProjectKey(value === NO_PROJECT_VALUE ? null : value)
              }
              items={[
                { value: NO_PROJECT_VALUE, label: "Choose a project…" },
                ...projectChoices.map((choice) => ({ value: choice.key, label: choice.label })),
              ]}
            >
              <SelectTrigger size="sm" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {projectChoices.map((choice) => (
                  <SelectItem key={choice.key} value={choice.key}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            aria-label="Task title"
          />
          {taskFieldsSupported ? (
            <>
              <Textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                rows={4}
                placeholder="Full task description delivered when planning starts (optional)"
                aria-label="Task details"
                aria-invalid={detailsTooLong || undefined}
              />
              {/* Quiet until the limit is close, then a live count. */}
              {detailsLength > THREAD_TASK_DETAILS_MAX_LENGTH * 0.9 ? (
                <p
                  className={cn(
                    "-mt-2 text-right text-3xs tabular-nums",
                    detailsTooLong ? "text-destructive" : "text-muted-foreground/70",
                  )}
                >
                  {detailsTooLong
                    ? `Too long to save: ${detailsLength.toLocaleString("en-US")} / ${THREAD_TASK_DETAILS_MAX_LENGTH.toLocaleString("en-US")} characters`
                    : `${detailsLength.toLocaleString("en-US")} / ${THREAD_TASK_DETAILS_MAX_LENGTH.toLocaleString("en-US")} characters`}
                </p>
              ) : null}
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
                <p className="mt-1 text-3xs text-muted-foreground/70">
                  {
                    WORKFLOW_OPTIONS.find(
                      (option) => option.value === (presetId ?? DEFAULT_WORKFLOW_VALUE),
                    )?.description
                  }
                </p>
              </div>
            </>
          ) : null}
        </form>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
        <Button size="sm" disabled={!canSubmit} onClick={submit}>
          {editing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}
