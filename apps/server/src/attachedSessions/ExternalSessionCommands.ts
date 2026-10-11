/**
 * How the orchestrator treats threads that mirror a session running outside T3
 * (see OrchestrationV2ExternalSession). Kept out of Orchestrator.ts so it hooks
 * in at a few call sites: the guard before the command switch, one check in
 * `message.dispatch`, and the two `thread.external-session.*` cases.
 */
import {
  CommandId,
  ThreadId,
  isExternalSessionThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import type { AttachedEventDraft } from "./AttachedSessionMapper.ts";

export class OrchestratorExternalSessionThreadReadOnlyError extends Schema.TaggedError<OrchestratorExternalSessionThreadReadOnlyError>()(
  "OrchestratorExternalSessionThreadReadOnlyError",
  { commandId: CommandId, commandType: Schema.String, threadId: ThreadId },
) {
  override get message(): string {
    return "This thread mirrors a session running outside T3 Code. Control it where it runs; from here you can only send it messages.";
  }
}

/** What the orchestrator lends these handlers, so they never import its internals. */
export interface ExternalSessionCommandDeps<LoadError, RejectError> {
  readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, LoadError>;
  readonly reject: (cause: string) => RejectError;
}

/** The thread-event draft; its schema shares one struct across many thread event types. */
type ThreadMetadataUpdated = AttachedEventDraft extends infer Draft
  ? Draft extends { readonly type: infer Type }
    ? "thread.metadata-updated" extends Type
      ? Draft
      : never
    : never
  : never;

/**
 * The thread a command would start, steer, stop, answer for, rewind, fork or
 * reconfigure. `message.dispatch` is checked where it already loads its thread.
 */
function guardedThreadId(command: OrchestrationV2ServerCommand): ThreadId | null {
  switch (command.type) {
    case "run.interrupt":
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
    case "checkpoint.rollback":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider.switch":
      return command.threadId;
    case "thread.pull-request.watch":
      return command.watching ? command.threadId : null;
    // A fork would start a T3-owned copy of a conversation T3 cannot resume,
    // and a merge would write T3 history into a session it does not own.
    case "thread.fork":
      return command.sourceThreadId;
    case "thread.merge_back":
      return command.targetThreadId;
    default:
      return null;
  }
}

/**
 * An external-session thread's conversation runs, and is controlled, outside
 * T3. Commands that would act on it fail with that reason instead of a
 * provider lookup failure. Runs once before the orchestrator's command switch.
 */
export const rejectExternalSessionControl = <LoadError, RejectError>(
  command: OrchestrationV2ServerCommand,
  deps: ExternalSessionCommandDeps<LoadError, RejectError>,
) =>
  Effect.gen(function* () {
    const threadId = guardedThreadId(command);
    if (threadId === null) return;
    yield* rejectExternalSessionMessage(command, threadId, yield* deps.getThread(threadId));
  });

/** For a command that already loaded its thread. */
export const rejectExternalSessionMessage = (
  command: OrchestrationV2ServerCommand,
  threadId: ThreadId,
  thread: Pick<OrchestrationV2AppThread, "externalSession">,
) =>
  isExternalSessionThread(thread)
    ? Effect.fail(
        new OrchestratorExternalSessionThreadReadOnlyError({
          commandId: command.commandId,
          commandType: command.type,
          threadId,
        }),
      )
    : Effect.void;

/**
 * Decides the `thread.external-session.*` commands. A send only records intent:
 * delivery is an effect that runs after the command commits, and its event
 * just carries the receipt. An update stamps the marker and the session's
 * activity, and turns automatic settlement off.
 */
export const dispatchExternalSessionCommand = <LoadError, RejectError, EmitError>(
  command: Extract<
    OrchestrationV2ServerCommand,
    {
      readonly type: "thread.external-session.message.send" | "thread.external-session.update";
    }
  >,
  deps: ExternalSessionCommandDeps<LoadError, RejectError> & {
    readonly emit: (event: ThreadMetadataUpdated) => Effect.Effect<unknown, EmitError>;
    readonly enqueue: (effect: PendingOrchestrationEffectV2) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const thread = yield* deps.getThread(command.threadId);
    const now = yield* DateTime.now;
    if (command.type === "thread.external-session.message.send") {
      if (!isExternalSessionThread(thread)) {
        return yield* Effect.fail(
          deps.reject("Only a thread that mirrors an external session takes this message."),
        );
      }
      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* Effect.fail(deps.reject(`Thread ${command.threadId} is not active.`));
      }
      yield* deps.emit({
        type: "thread.metadata-updated" as const,
        threadId: command.threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* deps.enqueue({
        id: `effect:external-session-message:${command.commandId}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "external-session.message.send", text: command.text },
      });
      return;
    }
    // A thread that already mirrors a different session is never re-pointed.
    const current = thread.externalSession ?? null;
    if (
      thread.deletedAt !== null ||
      (current !== null && current.nativeSessionId !== command.externalSession.nativeSessionId)
    ) {
      return yield* Effect.fail(
        deps.reject(`Thread ${command.threadId} does not mirror this session.`),
      );
    }
    yield* deps.emit({
      type: "thread.metadata-updated" as const,
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...thread,
        externalSession: command.externalSession,
        autoSettleDisabledAt: thread.autoSettleDisabledAt ?? now,
      },
    });
  });
