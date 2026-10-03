import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { loadAttachedSessionCursors } from "./AttachedSessionCursors.ts";
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

  it("strips the cross-session-message wrapper T3 injects around a user message", () => {
    expect(
      parse({
        type: "user",
        uuid: "u",
        message: {
          content:
            '<cross-session-message from="uds:/run/user/1000/cc-socks/42.sock" from-name="T3" from-mode="bypassPermissions">ship it please',
        },
      }),
    ).toEqual([
      {
        kind: "message",
        role: "user",
        uuid: "u",
        text: "ship it please",
        images: [],
        createdAt: fallback,
      },
    ]);
  });

  it("strips a cross-session wrapper that carries a closing tag", () => {
    expect(
      parse({
        type: "user",
        uuid: "u2",
        message: {
          content: '<cross-session-message from="uds:/x.sock">hello there</cross-session-message>',
        },
      }),
    ).toEqual([
      {
        kind: "message",
        role: "user",
        uuid: "u2",
        text: "hello there",
        images: [],
        createdAt: fallback,
      },
    ]);
  });

  it("leaves an ordinary user message that only mentions the tag name intact", () => {
    expect(
      parse({
        type: "user",
        uuid: "u3",
        message: { content: "what is a cross-session-message?" },
      }),
    ).toEqual([
      {
        kind: "message",
        role: "user",
        uuid: "u3",
        text: "what is a cross-session-message?",
        images: [],
        createdAt: fallback,
      },
    ]);
  });
});

const cursorFileWithOneBadEntry = JSON.stringify({
  sessions: {
    good: {
      transcriptPath: null,
      offset: 42,
      status: "ready",
      waitRequestId: null,
      toolCalls: {},
      endedAt: null,
    },
    bad: { offset: "not a number" },
  },
});

describe("loadAttachedSessionCursors", () => {
  it.effect("drops only the entries it cannot read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = `${yield* fileSystem.makeTempDirectoryScoped()}/attached-sessions.json`;
      yield* fileSystem.writeFileString(filePath, cursorFileWithOneBadEntry);

      const cursors = yield* loadAttachedSessionCursors(filePath, 0);
      expect([...cursors.keys()]).toEqual(["good"]);
      expect(cursors.get("good")?.offset).toBe(42);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
