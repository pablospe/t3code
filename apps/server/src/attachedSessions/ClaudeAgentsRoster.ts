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
}

export interface ClaudeAgentsRosterSnapshot {
  readonly sessions: ReadonlyArray<ClaudeAgentsRosterEntry>;
  /** Directory holding `projects/<slug>/<sessionId>.jsonl` transcripts. */
  readonly configDir: string;
}

/** Only the human-driven sessions; T3 Code's own SDK sessions are not `interactive`. */
export function parseClaudeAgentsRoster(
  stdout: string,
): Option.Option<ReadonlyArray<ClaudeAgentsRosterEntry>> {
  const parsed = decodeJson(stdout);
  if (Option.isNone(parsed) || !Array.isArray(parsed.value)) return Option.none();
  return Option.some(
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
        },
      ];
    }),
  );
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
      return Option.map(parseClaudeAgentsRoster(result.stdout), (sessions) => ({
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
