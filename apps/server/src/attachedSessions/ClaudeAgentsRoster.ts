/**
 * The roster of Claude CLI sessions running on this machine, from
 * `claude agents --json`. The output format is undocumented, so entries that do
 * not decode are dropped rather than failing the probe.
 */
import * as NodeOS from "node:os";

import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import { ProcessRunner } from "../processRunner.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const RosterEntry = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  name: Schema.optional(Schema.String),
  waitingFor: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Finite),
  pid: Schema.optional(Schema.Finite),
});

const decodeRosterEntry = Schema.decodeUnknownOption(RosterEntry);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export interface ClaudeAgentsRosterEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly status: "busy" | "waiting" | "idle";
  readonly waitingFor: string | null;
  readonly startedAt: number | null;
  readonly pid: number | null;
  /**
   * The process descends from this T3 server: a run T3 started, or its send
   * relay. Such a session already has a thread, or is plumbing, and is never
   * mirrored. Its native session id can be unknown to T3 while the run starts,
   * so this is the reliable signal.
   */
  readonly spawnedByServer: boolean;
}

interface ClaudeAgentsRosterSnapshot {
  readonly sessions: ReadonlyArray<ClaudeAgentsRosterEntry>;
  /** Directory holding `projects/<slug>/<sessionId>.jsonl` transcripts. */
  readonly configDir: string;
}

const STATUS_RANK = { busy: 2, waiting: 1, idle: 0 } as const;

/**
 * One entry per session. Two processes can run the same session (a resumed
 * copy in another terminal), and the roster lists each. The session reads as
 * its most active process (busy, then waiting, then idle), and that process
 * also gives the name messages are addressed to, since it is the one the user
 * is working in. Ties go to the most recently started process.
 */
function mergeSessionProcesses(
  entries: ReadonlyArray<ClaudeAgentsRosterEntry>,
): ReadonlyArray<ClaudeAgentsRosterEntry> {
  const bySession = new Map<string, ClaudeAgentsRosterEntry>();
  for (const entry of entries) {
    const current = bySession.get(entry.sessionId);
    const wins =
      current === undefined ||
      STATUS_RANK[entry.status] > STATUS_RANK[current.status] ||
      (STATUS_RANK[entry.status] === STATUS_RANK[current.status] &&
        (entry.startedAt ?? 0) > (current.startedAt ?? 0));
    const spawnedByServer = entry.spawnedByServer || current?.spawnedByServer === true;
    if (wins) bySession.set(entry.sessionId, { ...entry, spawnedByServer });
    else if (spawnedByServer) bySession.set(entry.sessionId, { ...current, spawnedByServer });
  }
  return [...bySession.values()];
}

/** Only the human-driven sessions; T3 Code's own SDK sessions are not `interactive`. */
export function parseClaudeAgentsRoster(
  stdout: string,
  serverDescendants: ReadonlySet<number> = new Set(),
): Option.Option<ReadonlyArray<ClaudeAgentsRosterEntry>> {
  const parsed = decodeJson(stdout);
  if (Option.isNone(parsed) || !Array.isArray(parsed.value)) return Option.none();
  return Option.some(
    mergeSessionProcesses(
      parsed.value.flatMap((value): ReadonlyArray<ClaudeAgentsRosterEntry> => {
        const entry = decodeRosterEntry(value);
        if (Option.isNone(entry) || entry.value.kind !== "interactive") return [];
        const { sessionId, cwd, status } = entry.value;
        if (sessionId.trim().length === 0 || cwd.trim().length === 0) return [];
        return [
          {
            sessionId,
            cwd,
            name: entry.value.name?.trim() || null,
            // An unknown status is a CLI we do not understand yet. Idle is the quiet reading.
            status: status === "busy" || status === "waiting" ? status : "idle",
            waitingFor: entry.value.waitingFor?.trim() || null,
            startedAt: entry.value.startedAt ?? null,
            pid: entry.value.pid ?? null,
            spawnedByServer:
              entry.value.pid !== undefined && serverDescendants.has(entry.value.pid),
          },
        ];
      }),
    ),
  );
}

/**
 * claude-mem spawns ephemeral interactive "observer" sessions constantly (a new
 * one roughly every minute), whose cwd lives inside its data directory
 * (`~/.claude-mem/observer-sessions/…`). They are `kind:"interactive"` like a
 * real session, so `kind` cannot tell them apart, but they are never agents the
 * user drives and must not be mirrored. Their cwd always sits inside a
 * `.claude-mem` directory, wherever the user's home resolves, which is the
 * robust signal used to skip them.
 */
export function isClaudeMemObserverSession(cwd: string): boolean {
  return cwd.split(/[/\\]+/).some((segment) => segment === ".claude-mem");
}

/**
 * The processes below `ancestorPid`, from `ps -A -o pid=,ppid=` output. Lines
 * that do not read as two numbers are skipped.
 */
export function descendantPids(psOutput: string, ancestorPid: number): ReadonlySet<number> {
  const children = new Map<number, Array<number>>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (
      pid === undefined ||
      ppid === undefined ||
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid)
    ) {
      continue;
    }
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = new Set<number>();
  const pending = [ancestorPid];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return found;
}

export class ClaudeAgentsRoster extends Context.Service<
  ClaudeAgentsRoster,
  {
    /**
     * `None` means the probe failed. Callers must not read that as "no sessions
     * are running", or one failed spawn would end every attached thread.
     */
    readonly snapshot: Effect.Effect<Option.Option<ClaudeAgentsRosterSnapshot>>;
  }
>()("t3/attachedSessions/ClaudeAgentsRoster") {}

const PROBE_TIMEOUT = "10 seconds";
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

export const layer = Layer.effect(
  ClaudeAgentsRoster,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const serverSettings = yield* ServerSettingsService;
    const path = yield* Path.Path;

    const snapshot = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const claudeSettings = Option.getOrElse(
        decodeClaudeSettings(settings.providerInstances[CLAUDE_INSTANCE_ID]?.config ?? {}),
        () => settings.providers.claudeAgent,
      );
      const env = yield* makeClaudeEnvironment(claudeSettings).pipe(
        Effect.provideService(Path.Path, path),
      );
      const configDir = path.resolve(
        expandHomePath(env.CLAUDE_CONFIG_DIR?.trim() || path.join(NodeOS.homedir(), ".claude")),
      );
      const result = yield* processRunner.run({
        command: claudeSettings.binaryPath,
        args: ["agents", "--json"],
        env,
        timeout: PROBE_TIMEOUT,
      });
      if (result.code !== 0) {
        yield* Effect.logDebug("attached-sessions.roster.probe-exit", { code: result.code });
        return Option.none<ClaudeAgentsRosterSnapshot>();
      }
      // Without a process table (no `ps`, e.g. on Windows) the provider-thread
      // check in the mirror is the only guard against mirroring T3's own runs.
      const processTable = yield* processRunner
        .run({ command: "ps", args: ["-A", "-o", "pid=,ppid="], timeout: PROBE_TIMEOUT })
        .pipe(
          Effect.map((ps) => (ps.code === 0 ? ps.stdout : "")),
          Effect.orElseSucceed(() => ""),
        );
      const serverDescendants = descendantPids(processTable, process.pid);
      return Option.map(parseClaudeAgentsRoster(result.stdout, serverDescendants), (sessions) => ({
        sessions,
        configDir,
      }));
    }).pipe(
      Effect.catch((cause: unknown) =>
        Effect.logDebug("attached-sessions.roster.probe-failed", { cause }).pipe(
          Effect.as(Option.none<ClaudeAgentsRosterSnapshot>()),
        ),
      ),
    );

    return ClaudeAgentsRoster.of({ snapshot });
  }),
);
