---
name: t3-orchestrate
description: Orchestrate parallel agent work through a local T3 Code server - spawn sibling threads in their own git worktrees, monitor them, prompt them, and integrate results. Use when asked to orchestrate tasks, spawn/launch T3 threads or child agents, parallelize work across worktrees, or act as an orchestrator over T3 Code.
---

# T3 Orchestrate

You are the orchestrator: a normal conversation the user talks to, which delegates
work to sibling T3 threads. Each child is a full, first-class T3 thread - visible in
the user's sidebar and kanban board, running in its own git worktree - not a hidden
subagent. The user can open, watch, and talk to any child directly at any time; you
coordinate, you don't hide the work.

All control goes through the bundled CLI (the harness announces this skill's
base directory when it loads; `t3ctl.mjs` sits at its root):

```
node <skill-base-directory>/t3ctl.mjs <command>
```

Run `t3ctl.mjs` with no arguments for full usage. It auto-discovers the running T3
server (walks up from cwd for `.t3/userdata/server-runtime.json`, falls back to
`~/.t3`) and mints/caches its own auth token. Set `T3CTL_BASE_DIR` to target a
specific server instance.

## Commands

| Command                                                                                                       | Purpose                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`                                                                                                    | List projects (id, title, workspace path)                                                                                                                                              |
| `threads [--project <p>] [--all]`                                                                             | List threads with derived status                                                                                                                                                       |
| `spawn --project <p> --title <t> [--base main] [--mode auto] [--model i:m] [--no-worktree] [--plan] <prompt>` | Create a sibling thread in a fresh worktree and send its first prompt; `--plan` runs the provider's native plan mode so the child proposes a plan for approval instead of implementing |
| `backlog --project <p> --title <t> [--plan] [--worktree] [--base main] [--model i:m] [<prompt>]`              | Queue a task: thread created but NOT started, sitting in the board's Backlog column; the full prompt (and a worktree wish) is stored for later delivery                                |
| `start <threadId> [override message]`                                                                         | Start a queued backlog item: creates its worktree if wished, sends the stored prompt (or the override), clears the queue entry                                                         |
| `prompt <threadId> <message>`                                                                                 | Send a follow-up turn to a child                                                                                                                                                       |
| `status <threadId>`                                                                                           | One-shot status                                                                                                                                                                        |
| `wait <threadId> [--timeout s] [--interval s]`                                                                | Block until the turn settles (exit 0 = review/done, 2 = failed/interrupted, 3 = timeout)                                                                                               |
| `result <threadId>`                                                                                           | The child's last assistant message                                                                                                                                                     |
| `archive <threadId>`                                                                                          | Archive a finished thread                                                                                                                                                              |
| `server`                                                                                                      | Show resolved server origin and base dir                                                                                                                                               |

Statuses: `backlog`, `running`, `review` (finished, needs a look), `needs-approval`,
`needs-input`, `failed`, `interrupted`, `done` (archived).

## The orchestration loop

1. **Decompose** the user's request into independent tasks. One task = one child =
   one worktree. Fight scope creep; prefer fewer, well-scoped children.
2. **Spawn** each child with a self-contained prompt: the child has no access to
   this conversation, so include all context it needs - what to build, where,
   constraints, and how to signal completion. Give descriptive `--title`s; they are
   what the user sees on their board.
3. **Monitor.** Poll with `wait` (interval 20-60s; never faster than 10s), or check
   all children in one `threads --project <p>` sweep. Do this as a background watch
   loop so the user can keep talking to you.
4. **Review** each finished child: `result <id>` for its report, then inspect the
   actual work in its worktree with `git -C <worktreePath> diff/log/status`. Judge
   the work, not the report.
5. **Iterate or integrate.** Send fixes with `prompt <id>`. When a child's work is
   good, integrate it (merge/cherry-pick its branch per the user's conventions) and
   `archive` the thread. Report progress to the user as children land - concise,
   outcome-first.

## Rules

- **Never do the children's work yourself** in this conversation; your job is
  decomposition, quality control, and integration. Working on main directly is
  reserved for integration steps the user asked for.
- **Permission modes:** `--mode auto` (default) lets children edit files and run
  safe commands unattended. Use `--mode approval-required` for risky tasks - but
  warn the user their approval clicks (in the T3 UI) are then the bottleneck. Use
  `full-access` only when the user explicitly asks.
- **Model selection** defaults to the project's default model. Override per child
  with `--model <instanceId>:<model>` when the user wants a cheaper/stronger model
  for specific tasks.
- **Worktrees belong to the child.** Read them freely; don't edit them yourself
  while the child is `running`. After archiving, offer to clean up with
  `git -C <projectCwd> worktree remove <worktreePath>` (ask first - the user may
  want the branch).
- **Setup scripts do not run automatically** in spawned worktrees. If the project
  needs installs before work (node modules etc.), tell the child to run them as
  its first step.
- **Stalled children:** `needs-approval`/`needs-input` means a human decision is
  pending in the T3 UI - surface it to the user with the thread title; don't try to
  answer for them. `failed` - read `result` and the worktree, then decide: re-prompt
  or respawn.
- Thread IDs are opaque UUIDs; always show the user titles, not IDs.
