import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { interpretRelayTranscript, resolveRosterRecipient } from "./AttachedSessionSender.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// Minimal SDK-message shapes the relay produces, for the stream interpreter.
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (toolUseId: string, content: unknown, isError = false) => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  },
});
const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

describe("interpretRelayTranscript", () => {
  it("reports delivered when SendMessage ran and its result succeeded", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_list", "ListAgents"),
        toolResult("tu_list", "[{ sessionId, name }]"),
        toolUse("tu_send", "SendMessage", { to: "browser-recipient-a1", message: "hi" }),
        toolResult("tu_send", "Message delivered."),
        assistantText("RELAY_RESULT: SENT"),
        { type: "result", subtype: "success" },
      ],
      SESSION_ID,
    );
    expect(outcome).toEqual({
      delivered: true,
      detail: "relay confirmed SENT",
      to: "browser-recipient-a1",
    });
  });

  it("does not mistake the ListAgents result for the SendMessage result", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_list", "ListAgents"),
        toolResult("tu_list", "sessions..."),
        assistantText("done"),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("never called SendMessage");
    expect(outcome.to).toBeNull();
  });

  it("fails when SendMessage returns an error result", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult("tu_send", "no such session", true),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("SendMessage failed");
    expect(outcome.to).toBe("x");
  });

  it("treats a same-machine success carrying 'queued there' boilerplate as delivered", () => {
    // The real success payload: success:true plus forward-looking conditional
    // boilerplate ("queued there — a [Cross-session delivery notice] follows if
    // that session holds it … or refuses it"). That is not a hold.
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "uds-probe-sess-34" }),
        toolResult(
          "tu_send",
          '{"success":true,"message":"“nonce-7f3a” → uds-probe-sess-34 (another Claude session on this machine; queued there — a [Cross-session delivery notice] follows if that session holds it (different permission mode: its user must approve first) or refuses it)","msg_id":"m_123"}',
        ),
      ],
      "uds-probe-sess-34",
    );
    expect(outcome.delivered).toBe(true);
    expect(outcome.to).toBe("uds-probe-sess-34");
  });

  it("fails when the SendMessage result reports success:false", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult("tu_send", '{"success":false,"message":"unknown recipient"}'),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("SendMessage failed");
  });

  it("treats an explicit past-tense hold notice as not delivered", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult(
          "tu_send",
          '{"success":true,"message":"[Cross-session delivery notice] your message was held by the recipient (awaiting approval)"}',
        ),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("held by the recipient");
  });

  it("honors an explicit RELAY_RESULT: FAILED marker over a completed run", () => {
    const outcome = interpretRelayTranscript(
      [
        toolUse("tu_send", "SendMessage", { to: "x" }),
        toolResult("tu_send", "ok"),
        assistantText("RELAY_RESULT: FAILED: session not found"),
      ],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("session not found");
  });

  it("fails when the SendMessage result is never observed", () => {
    const outcome = interpretRelayTranscript(
      [toolUse("tu_send", "SendMessage", { to: "x" })],
      SESSION_ID,
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toContain("no observable result");
  });
});

describe("resolveRosterRecipient", () => {
  const snapshotOf = (
    sessions: ReadonlyArray<{ readonly sessionId: string; readonly name: string | null }>,
  ) => Option.some({ sessions });

  it("resolves a running sessionId to its current name", () => {
    const result = resolveRosterRecipient(
      snapshotOf([
        { sessionId: "other", name: "peer-one" },
        { sessionId: SESSION_ID, name: "uds-probe-sess-34" },
      ]),
      SESSION_ID,
    );
    expect(result).toEqual({ kind: "found", name: "uds-probe-sess-34" });
  });

  it("fails fast when the sessionId is not in the roster", () => {
    const result = resolveRosterRecipient(
      snapshotOf([{ sessionId: "other", name: "peer-one" }]),
      SESSION_ID,
    );
    expect(result).toEqual({
      kind: "error",
      detail: "The terminal session is no longer running.",
    });
  });

  it("fails when the roster probe returned nothing", () => {
    expect(resolveRosterRecipient(Option.none(), SESSION_ID).kind).toBe("error");
  });

  it("fails when the running session has no addressable name", () => {
    const result = resolveRosterRecipient(
      snapshotOf([{ sessionId: SESSION_ID, name: null }]),
      SESSION_ID,
    );
    expect(result).toEqual({
      kind: "error",
      detail: "The terminal session has no addressable name.",
    });
  });
});
