import { formatExternalSessionActivity } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, OrchestrationV2ExternalSession, ThreadId } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/**
 * Stands in for the composer on a thread that mirrors a session running
 * outside T3, such as `claude` in a terminal. That session stays in charge, so
 * there is no model, stop, queue or steer here: a message is handed to the
 * session, and it shows in the thread once the session records it.
 */
export function ExternalSessionComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activity: OrchestrationV2ExternalSession["activity"];
}) {
  const activity = props.activity ?? null;
  const statusRef = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState("");
  const send = useAtomCommand(threadEnvironment.sendExternalSessionMessage);
  const ended = activity?.status === "ended";
  const live = activity?.status === "running";

  // Live labels tick through DOM writes, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatExternalSessionActivity(activity, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [activity, live]);

  const submit = () => {
    const message = text.trim();
    if (message.length === 0 || ended) return;
    setText("");
    void send({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, text: message },
    }).then((result) => {
      // Keep what the user typed when the server did not take it.
      if (result._tag === "Failure") setText((current) => (current === "" ? message : current));
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-3xl p-2">
      <span className="flex min-w-0 items-center gap-2 px-3 text-sm">
        <span ref={statusRef} className="min-w-0 truncate text-muted-foreground tabular-nums" />
        <span className="ms-auto shrink-0 text-muted-foreground max-sm:hidden">
          Runs in your terminal
        </span>
      </span>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Textarea
          aria-label="Message the terminal session"
          placeholder={ended ? "The session has ended" : "Message the terminal session"}
          disabled={ended}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Send to the terminal session"
          disabled={ended || text.trim().length === 0}
        >
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  );
}
