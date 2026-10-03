import { formatExternalSessionActivity } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, OrchestrationV2ExternalSession, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Replaces the composer on a thread that mirrors a session running outside T3,
 * such as `claude` in a terminal. That session stays in charge, so there is no
 * model, stop, queue or steer here: a message is handed to the session, and it
 * shows in the thread once the session records it.
 */
export function ExternalSessionComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activity: OrchestrationV2ExternalSession["activity"];
}) {
  const activity = props.activity ?? null;
  const live = activity?.status === "running";
  const ended = activity?.status === "ended";
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [text, setText] = useState("");
  const send = useAtomCommand(threadEnvironment.sendExternalSessionMessage);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live]);
  const statusLabel = formatExternalSessionActivity(activity, nowMs);

  const submit = () => {
    const message = text.trim();
    if (message.length === 0 || ended) return;
    setText("");
    void send({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, text: message, creationSource: "mobile" },
    }).then((result) => {
      // Keep what the user typed when the server did not take it.
      if (result._tag === "Failure") setText((current) => (current === "" ? message : current));
    });
  };

  return (
    <View className="gap-2 rounded-[20px] border border-border-subtle bg-card-alt p-2">
      <Text
        numberOfLines={2}
        className="px-2 font-sans text-xs text-foreground-secondary"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {statusLabel} · Runs in your terminal
      </Text>
      <View className="flex-row items-end gap-2">
        <View className="min-w-0 flex-1">
          <TextInput
            value={text}
            editable={!ended}
            multiline
            onChangeText={setText}
            accessibilityLabel="Message the terminal session"
            placeholder={ended ? "The session has ended" : "Message the terminal session"}
            className="max-h-40 min-h-[44px] rounded-2xl border border-input-border bg-input px-3.5 py-2.5 font-sans text-base text-foreground"
          />
        </View>
        <RequestActionButton
          label="Send"
          disabled={ended || text.trim().length === 0}
          onPress={submit}
        />
      </View>
    </View>
  );
}
