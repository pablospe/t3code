#!/usr/bin/env node
// t3ctl - drive a local T3 Code server from an agent: spawn sibling threads
// (each in its own git worktree), prompt them, poll status, read results.
// Zero dependencies; speaks T3's /api/orchestration HTTP API directly.
//
// Environment:
//   T3CTL_BASE_DIR   T3 data dir (contains userdata/). Default: walk up from
//                    cwd looking for .t3/userdata/server-runtime.json, then ~/.t3
//   T3CTL_TOKEN      bearer token override (skips mint/cache)
//   T3CTL_T3_BIN     command used to mint tokens (default: auto-detect)

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
// Everything after a literal `--` is positional (prompt text), invisible to
// flag parsing - otherwise a prompt mentioning "--mode" would be spliced
// apart by takeFlag and corrupt both the prompt and the command.
const positionalTail = (() => {
  const separator = args.indexOf("--");
  if (separator === -1) return [];
  return args.splice(separator).slice(1);
})();
const cmd = args.shift();

function fail(message) {
  console.error(`t3ctl: ${message}`);
  process.exit(1);
}

function takeFlag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeBoolFlag(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

// ---------- server discovery ----------

function findBaseDir() {
  if (process.env.T3CTL_BASE_DIR) return resolve(process.env.T3CTL_BASE_DIR);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".t3", "userdata", "server-runtime.json"))) {
      return join(dir, ".t3");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = join(homedir(), ".t3");
  if (existsSync(join(home, "userdata", "server-runtime.json"))) return home;
  fail("no running T3 server found (no server-runtime.json); set T3CTL_BASE_DIR");
}

const baseDir = findBaseDir();
const runtimePath = join(baseDir, "userdata", "server-runtime.json");
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
const origin = process.env.T3CTL_ORIGIN ?? runtime.origin;

// ---------- auth ----------

const tokenCachePath = join(baseDir, "userdata", "t3ctl-token.json");

function detectMintCommand() {
  if (process.env.T3CTL_T3_BIN) return process.env.T3CTL_T3_BIN.split(" ");
  // A source checkout serving this base dir can mint with its own bin.
  let dir = dirname(baseDir);
  for (;;) {
    const bin = join(dir, "apps", "server", "src", "bin.ts");
    if (existsSync(bin)) return ["node", bin];
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ["t3"]; // installed CLI (npx t3 / desktop bundle)
}

function mintToken() {
  const [bin, ...prefix] = detectMintCommand();
  const out = execFileSync(
    bin,
    [
      ...prefix,
      "auth",
      "session",
      "issue",
      "--token-only",
      "--label",
      "t3ctl",
      "--base-dir",
      baseDir,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const token = out.split("\n").filter(Boolean).pop();
  if (!token) fail("token mint produced no output");
  mkdirSync(dirname(tokenCachePath), { recursive: true });
  writeFileSync(tokenCachePath, JSON.stringify({ token }), { mode: 0o600 });
  return token;
}

function loadToken() {
  if (process.env.T3CTL_TOKEN) return process.env.T3CTL_TOKEN;
  try {
    return JSON.parse(readFileSync(tokenCachePath, "utf8")).token;
  } catch {
    return mintToken();
  }
}

let token = loadToken();

async function api(method, path, body) {
  const doFetch = () =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let response = await doFetch();
  if (response.status === 401 && !process.env.T3CTL_TOKEN) {
    token = mintToken();
    response = await doFetch();
  }
  if (!response.ok) {
    const text = await response.text();
    fail(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return response.json();
}

const shellSnapshot = () => api("GET", "/api/orchestration/shell");
const dispatch = (command) => api("POST", "/api/orchestration/dispatch", command);

// ---------- backlog queue (t3ctl-owned sidecar) ----------
// T3 threads have no "message without a turn", so queued task prompts live
// beside the server state until `start` delivers them.

const backlogQueuePath = join(baseDir, "userdata", "t3ctl-backlog.json");

function readBacklogQueue() {
  try {
    return JSON.parse(readFileSync(backlogQueuePath, "utf8"));
  } catch {
    return {};
  }
}

function writeBacklogQueue(queue) {
  writeFileSync(backlogQueuePath, JSON.stringify(queue, null, 2), { mode: 0o600 });
}

function createTaskWorktree(cwd, title, branchFlag, baseBranch) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 32) || "task";
  const branch = branchFlag ?? `orc/${slug}-${randomUUID().slice(0, 4)}`;
  // Mirrors T3's own layout: <baseDir>/worktrees/<repoName>/<branch with / -> ->
  const repoName = cwd.split("/").filter(Boolean).pop();
  const worktreePath = join(baseDir, "worktrees", repoName, branch.replaceAll("/", "-"));
  execFileSync("git", ["-C", cwd, "worktree", "add", "-b", branch, worktreePath, baseBranch], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { branch, worktreePath };
}

// ---------- helpers over the read model ----------

function pick(object, names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object[name] !== null) return object[name];
  }
  return undefined;
}

const projectPath = (project) => pick(project, ["workspaceRoot", "path", "cwd", "rootPath"]);

function threadStatus(thread) {
  if (thread.archivedAt) return "done";
  if (thread.hasPendingApprovals) return "needs-approval";
  if (thread.hasPendingUserInput) return "needs-input";
  if (thread.hasActionableProposedPlan) return "planning";
  const session = thread.session?.status;
  if (session === "running" || session === "starting") return "running";
  if (session === "error") return "failed";
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return "running";
  }
  const turn = thread.latestTurn?.state;
  if (turn === "running") return "running";
  if (turn === "error") return "failed";
  if (turn === "interrupted") return "interrupted";
  if (turn === "completed") return "review";
  return "backlog";
}

function threadRow(thread, projects) {
  const project = projects.find((candidate) => candidate.id === thread.projectId);
  return {
    threadId: thread.id,
    title: thread.title,
    project: project?.title ?? thread.projectId,
    status: threadStatus(thread),
    session: thread.session?.status ?? null,
    latestTurn: thread.latestTurn?.state ?? null,
    branch: thread.branch ?? null,
    worktreePath: thread.worktreePath ?? null,
    updatedAt: thread.updatedAt,
  };
}

function resolveProject(projects, selector) {
  const match = projects.find(
    (project) =>
      project.id === selector ||
      project.title === selector ||
      projectPath(project) === resolve(selector),
  );
  if (!match) {
    fail(
      `project "${selector}" not found. Known: ${projects
        .map((project) => `${project.title} (${project.id})`)
        .join(", ")}`,
    );
  }
  return match;
}

function latestModelSelection(threads, projectId) {
  const candidates = threads
    .filter((thread) => thread.modelSelection)
    .sort((left, right) => Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0));
  return (
    candidates.find((thread) => thread.projectId === projectId)?.modelSelection ??
    candidates[0]?.modelSelection
  );
}

const output = (value) => console.log(JSON.stringify(value, null, 2));

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ---------- commands ----------

async function main() {
  switch (cmd) {
    case "projects": {
      const snapshot = await shellSnapshot();
      output(
        snapshot.projects.map((project) => ({
          projectId: project.id,
          title: project.title,
          path: projectPath(project) ?? null,
        })),
      );
      return;
    }

    case "threads": {
      const projectSelector = takeFlag("project");
      const all = takeBoolFlag("all");
      const snapshot = await shellSnapshot();
      let threads = snapshot.threads;
      if (projectSelector) {
        const project = resolveProject(snapshot.projects, projectSelector);
        threads = threads.filter((thread) => thread.projectId === project.id);
      }
      if (!all) threads = threads.filter((thread) => !thread.archivedAt);
      const queue = readBacklogQueue();
      output(
        threads.map((thread) => ({
          ...threadRow(thread, snapshot.projects),
          // Only unstarted threads truly have a queued prompt; details on a
          // running or finished thread are reference text, not a queue entry.
          ...(thread.latestTurn === null && (thread.taskDetails || queue[thread.id]?.prompt)
            ? { queuedPrompt: true }
            : {}),
        })),
      );
      return;
    }

    case "spawn": {
      const projectSelector = takeFlag("project") ?? fail("--project is required");
      const title = takeFlag("title") ?? fail("--title is required");
      const baseBranch = takeFlag("base", "main");
      const branchFlag = takeFlag("branch");
      const mode = takeFlag("mode", "auto");
      const modelOverride = takeFlag("model");
      const noWorktree = takeBoolFlag("no-worktree");
      // Plan mode: the provider runs its native planning flow and proposes a
      // plan for approval instead of implementing.
      const planMode = takeBoolFlag("plan");
      const interactionMode = planMode ? "plan" : "default";
      const prompt = [...args, ...positionalTail].join(" ").trim();
      if (!prompt) fail("prompt is required (last argument)");

      const snapshot = await shellSnapshot();
      const project = resolveProject(snapshot.projects, projectSelector);
      const cwd = projectPath(project) ?? fail(`project ${project.id} has no path`);

      let modelSelection;
      if (modelOverride) {
        const [instanceId, ...model] = modelOverride.split(":");
        modelSelection = { instanceId, model: model.join(":") };
      } else {
        modelSelection =
          project.defaultModelSelection ??
          latestModelSelection(snapshot.threads, project.id) ??
          fail(
            "project has no default model and no thread to copy one from; pass --model <instanceId>:<model>",
          );
      }

      // The websocket client does thread bootstrap server-side; over plain
      // HTTP the engine requires the thread to exist first, so t3ctl performs
      // the same sequence itself: worktree, thread.create, first turn.
      let branch = null;
      let worktreePath = null;
      if (!noWorktree) {
        ({ branch, worktreePath } = createTaskWorktree(cwd, title, branchFlag, baseBranch));
      }

      const now = new Date().toISOString();
      const threadId = randomUUID();
      await dispatch({
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId: project.id,
        title,
        modelSelection,
        runtimeMode: mode,
        interactionMode,
        branch,
        worktreePath,
        createdAt: now,
      });
      const result = await dispatch({
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
        runtimeMode: mode,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
      output({
        threadId,
        title,
        project: project.title,
        mode,
        branch,
        worktreePath,
        sequence: result.sequence,
      });
      return;
    }

    case "backlog": {
      // Create the thread WITHOUT starting a turn: it sits in the board's
      // Backlog column, holding the full task prompt in the t3ctl queue,
      // until `t3ctl start <threadId>` delivers it.
      const projectSelector = takeFlag("project") ?? fail("--project is required");
      const title = takeFlag("title") ?? fail("--title is required");
      const mode = takeFlag("mode", "auto");
      const planMode = takeBoolFlag("plan");
      const wantWorktree = takeBoolFlag("worktree");
      const baseBranch = takeFlag("base", "main");
      const modelOverride = takeFlag("model");
      const prompt = [...args, ...positionalTail].join(" ").trim();

      const snapshot = await shellSnapshot();
      const project = resolveProject(snapshot.projects, projectSelector);
      let modelSelection;
      if (modelOverride) {
        const [instanceId, ...model] = modelOverride.split(":");
        modelSelection = { instanceId, model: model.join(":") };
      } else {
        modelSelection =
          project.defaultModelSelection ??
          latestModelSelection(snapshot.threads, project.id) ??
          fail(
            "project has no default model and no thread to copy one from; pass --model <instanceId>:<model>",
          );
      }

      const threadId = randomUUID();
      const result = await dispatch({
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId: project.id,
        title,
        modelSelection,
        runtimeMode: mode,
        interactionMode: planMode ? "plan" : "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      });
      // The task prompt persists ON the thread (taskDetails), so every client
      // sees it; the local queue only remembers wishes the server has no
      // field for (worktree, start-time modes).
      if (prompt) {
        await dispatch({
          type: "thread.meta.update",
          commandId: randomUUID(),
          threadId,
          taskDetails: prompt,
        });
      }
      if (wantWorktree || planMode) {
        const queue = readBacklogQueue();
        queue[threadId] = {
          title,
          planMode,
          mode,
          worktree: wantWorktree,
          baseBranch,
          queuedAt: new Date().toISOString(),
        };
        writeBacklogQueue(queue);
      }
      output({
        threadId,
        title,
        project: project.title,
        status: "backlog",
        queuedPrompt: prompt.length > 0,
        sequence: result.sequence,
      });
      return;
    }

    case "start": {
      // Deliver a queued backlog item: create its worktree if one was wished
      // for, send the stored prompt (or an override), and clear the queue.
      const threadId = args.shift() ?? fail("usage: start <threadId> [override message]");
      const override = [...args, ...positionalTail].join(" ").trim();
      const queue = readBacklogQueue();
      const entry = queue[threadId];

      const snapshot = await shellSnapshot();
      const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
      if (!thread) fail(`thread ${threadId} not found`);
      // Prompt priority: explicit override, the thread's server-synced
      // taskDetails, then the legacy local queue.
      const text = override || thread.taskDetails || entry?.prompt;
      if (!text)
        fail(`no stored prompt for ${threadId}; pass a message: start <threadId> <message>`);

      if (entry?.worktree && !thread.worktreePath) {
        const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
        const cwd = project ? projectPath(project) : null;
        if (cwd) {
          const worktree = createTaskWorktree(
            cwd,
            entry.title ?? thread.title,
            undefined,
            entry.baseBranch ?? "main",
          );
          await dispatch({
            type: "thread.meta.update",
            commandId: randomUUID(),
            threadId,
            branch: worktree.branch,
            worktreePath: worktree.worktreePath,
          });
        }
      }

      const result = await dispatch({
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        message: { messageId: randomUUID(), role: "user", text, attachments: [] },
        runtimeMode: entry?.mode ?? thread.runtimeMode ?? "auto",
        interactionMode: entry?.planMode ? "plan" : (thread.interactionMode ?? "default"),
        createdAt: new Date().toISOString(),
      });
      if (entry) {
        delete queue[threadId];
        writeBacklogQueue(queue);
      }
      output({ threadId, started: true, usedStoredPrompt: !override, sequence: result.sequence });
      return;
    }

    case "prompt": {
      const threadId = args.shift() ?? fail("usage: prompt <threadId> <message>");
      const text = [...args, ...positionalTail].join(" ").trim();
      if (!text) fail("message is required");
      const snapshot = await shellSnapshot();
      const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
      if (!thread) fail(`thread ${threadId} not found`);
      const result = await dispatch({
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        message: { messageId: randomUUID(), role: "user", text, attachments: [] },
        runtimeMode: thread.runtimeMode ?? "auto",
        interactionMode: thread.interactionMode ?? "default",
        createdAt: new Date().toISOString(),
      });
      output({ threadId, sequence: result.sequence });
      return;
    }

    case "status": {
      const threadId = args.shift() ?? fail("usage: status <threadId>");
      const snapshot = await shellSnapshot();
      const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
      if (!thread) fail(`thread ${threadId} not found`);
      output(threadRow(thread, snapshot.projects));
      return;
    }

    case "result": {
      const threadId = args.shift() ?? fail("usage: result <threadId>");
      const detail = await api("GET", `/api/orchestration/threads/${threadId}`);
      const messages = pick(detail, ["messages", "items"]) ?? detail.thread?.messages ?? [];
      const assistant = [...messages]
        .reverse()
        .find(
          (message) =>
            (message.role ?? message.kind) === "assistant" && (message.text ?? message.content),
        );
      if (assistant) {
        output({ threadId, lastAssistantMessage: assistant.text ?? assistant.content });
      } else {
        // Shape unknown or empty: hand the caller the raw top-level keys so it
        // can dig itself rather than silently losing information.
        output({ threadId, note: "no assistant message found", keys: Object.keys(detail) });
      }
      return;
    }

    case "wait": {
      const threadId = args.shift() ?? fail("usage: wait <threadId> [--timeout s] [--interval s]");
      const timeoutS = Number(takeFlag("timeout", "3600"));
      const intervalS = Math.max(5, Number(takeFlag("interval", "20")));
      const deadline = Date.now() + timeoutS * 1000;
      for (;;) {
        const snapshot = await shellSnapshot();
        const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
        if (!thread) fail(`thread ${threadId} not found`);
        const status = threadStatus(thread);
        if (status !== "running") {
          output(threadRow(thread, snapshot.projects));
          // "planning" is a successful terminal state for a plan-mode child:
          // the turn finished and its proposed plan awaits approval.
          process.exit(status === "review" || status === "done" || status === "planning" ? 0 : 2);
        }
        if (Date.now() > deadline) {
          output({ threadId, status: "timeout", waitedSeconds: timeoutS });
          process.exit(3);
        }
        await sleep(intervalS * 1000);
      }
    }

    case "archive": {
      const threadId = args.shift() ?? fail("usage: archive <threadId>");
      const result = await dispatch({
        type: "thread.archive",
        commandId: randomUUID(),
        threadId,
      });
      output({ threadId, archived: true, sequence: result.sequence });
      return;
    }

    case "server": {
      output({ baseDir, origin, devUrl: runtime.devUrl ?? null, pid: runtime.pid });
      return;
    }

    default:
      console.log(`t3ctl - drive a local T3 Code server

Commands:
  projects                                   list projects
  threads [--project <p>] [--all]            list threads with derived status
  spawn --project <p> --title <t> [opts] <prompt>
        opts: --base <branch=main> --branch <name> --mode <runtime=auto>
              --model <instanceId>:<model> --no-worktree --plan
        prompt text may follow a literal -- to protect flag-like words
  backlog --project <p> --title <t> [--plan] [--worktree] [--base main] [<prompt>]
        queue a task: thread created but not started; the prompt is stored
        and delivered by \`start\`
  start <threadId> [override message]        start a queued backlog item
  prompt <threadId> <message>                send a follow-up turn
  status <threadId>                          one-line thread status
  result <threadId>                          last assistant message
  wait <threadId> [--timeout s] [--interval s]  block until turn settles
  archive <threadId>                         archive a finished thread
  server                                     show resolved server info

Statuses: backlog | running | review | needs-approval | needs-input | failed | interrupted | done`);
      process.exit(cmd ? 1 : 0);
  }
}

await main();
