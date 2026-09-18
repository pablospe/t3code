import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { parseAttachedTranscriptLine } from "./AttachedSessionTranscript.ts";
import { parseClaudeAgentsRoster } from "./ClaudeAgentsRoster.ts";

describe("parseClaudeAgentsRoster", () => {
  it("keeps interactive sessions and drops entries it cannot read", () => {
    const roster = parseClaudeAgentsRoster(
      JSON.stringify([
        {
          sessionId: "a",
          cwd: "/repo",
          kind: "interactive",
          status: "waiting",
          waitingFor: "permission prompt",
          name: "one",
          pid: 1,
        },
        { sessionId: "b", cwd: "/repo", kind: "sdk", status: "busy" },
        { sessionId: "c", cwd: "/repo", kind: "interactive", status: "some-future-status" },
        { cwd: "/repo", kind: "interactive", status: "busy" },
        "garbage",
      ]),
    );

    expect(Option.getOrThrow(roster)).toEqual([
      {
        sessionId: "a",
        cwd: "/repo",
        name: "one",
        status: "waiting",
        waitingFor: "permission prompt",
        startedAt: null,
      },
      {
        sessionId: "c",
        cwd: "/repo",
        name: null,
        status: "idle",
        waitingFor: null,
        startedAt: null,
      },
    ]);
  });

  it("reports unreadable output as a failed probe, not as an empty roster", () => {
    expect(Option.isNone(parseClaudeAgentsRoster("claude: command crashed"))).toBe(true);
    expect(Option.isNone(parseClaudeAgentsRoster('{"error":"nope"}'))).toBe(true);
  });
});

describe("parseAttachedTranscriptLine", () => {
  const fallback = "2026-09-18T10:00:00.000Z";
  const parse = (value: unknown) =>
    Option.getOrUndefined(parseAttachedTranscriptLine(JSON.stringify(value), fallback))?.entries;

  it("skips CLI bookkeeping, sidechains and broken lines", () => {
    expect(parse({ type: "ai-title", aiTitle: "x" })).toBeUndefined();
    expect(parse({ type: "system", uuid: "s", message: { content: "x" } })).toBeUndefined();
    expect(
      parse({ type: "assistant", uuid: "a", isSidechain: true, message: { content: "x" } }),
    ).toBeUndefined();
    expect(Option.isNone(parseAttachedTranscriptLine('{"type":"user","uu', fallback))).toBe(true);
  });

  it("does not turn a tool result into a user message", () => {
    expect(
      parse({
        type: "user",
        uuid: "u",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "boom" },
          ],
        },
      }),
    ).toEqual([{ kind: "tool-completed", toolUseId: "tool-1", failed: true, createdAt: fallback }]);
  });
});
