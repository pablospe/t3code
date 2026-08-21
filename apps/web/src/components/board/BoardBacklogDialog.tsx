import { useState } from "react";

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

/** Creates a card that sits in Backlog: the thread exists server-side from
    the moment it is named, but no turn starts until it is dragged out. */
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
  onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  const trimmed = title.trim();
  const canCreate = trimmed.length > 0 && modelAvailable;
  const submit = () => {
    if (!canCreate) return;
    onCreate(trimmed);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A dialog that reopens holding the last title reads as a stuck form.
        if (next) setTitle("");
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New backlog task</DialogTitle>
          <DialogDescription>
            {modelAvailable
              ? `Created in ${projectTitle ?? "the default project"} - it stays in Backlog until started; drag to Planning plans it from this title.`
              : "No model available - start any thread once first."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
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
