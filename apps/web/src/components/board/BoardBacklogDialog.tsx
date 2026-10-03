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

/** Creates a board task: a titled thread that sits in Backlog. The thread
    exists server-side from the moment it is named, but no run starts until
    it is dragged out. */
export function BoardBacklogDialog({
  open,
  onOpenChange,
  projectTitle,
  modelAvailable,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectTitle: string | null;
  modelAvailable: boolean;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  // Cleared on every close: a dialog that reopens holding the last task reads
  // as a stuck form.
  const handleOpenChange = (next: boolean) => {
    if (!next) setTitle("");
    onOpenChange(next);
  };
  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && modelAvailable;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed);
    handleOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
