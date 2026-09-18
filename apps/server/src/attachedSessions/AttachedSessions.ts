/**
 * Mirrors Claude CLI sessions that run outside T3 Code into read-only threads.
 *
 * The terminal stays the only owner of the session. This service only observes:
 * it polls the CLI roster for which sessions exist and what they are doing, and
 * tails each session's transcript for the conversation. Nothing is ever written
 * back, and no provider session or directory binding is created, so the provider
 * reaper and startup recovery never see these threads.
 */
import * as NodeCrypto from "node:crypto";

import {
  ATTACHED_CLAUDE_INSTANCE_ID,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatImageAttachment,
  CommandId,
  ProjectId,
  attachedClaudeThreadId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  attachedEntryCommands,
  attachedHistoryImportCommand,
  attachedSessionSetCommand,
  attachedSessionStatus,
  attachedWaitCommand,
  attachedWaitRequestId,
  type AttachedToolCall,
} from "./AttachedSessionMapper.ts";
import {
  parseAttachedTranscriptLine,
  type AttachedTranscriptEntry,
} from "./AttachedSessionTranscript.ts";
import {
  loadAttachedSessionCursors,
  saveAttachedSessionCursors,
} from "./AttachedSessionCursors.ts";
import { ClaudeAgentsRoster, type ClaudeAgentsRosterEntry } from "./ClaudeAgentsRoster.ts";

const DEFAULT_ROSTER_INTERVAL_MS = 5_000;
const DEFAULT_TAIL_INTERVAL_MS = 1_500;
// The most one read takes in, and how far back a first attach looks for history.
// A larger backlog is caught up over the following sweeps.
const READ_WINDOW_BYTES = 8 * 1024 * 1024;
// An empty roster is probed every sixth tick (30s by default) instead of every tick.
const EMPTY_ROSTER_SKIPPED_PROBES = 5;
const MAX_BACKFILL_MESSAGES = 200;
const NEWLINE = 0x0a;

export interface AttachedSessionsShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once every queued sweep has been processed. */
  readonly drain: Effect.Effect<void>;
  /** Queue one sweep now instead of waiting for the schedule. */
  readonly sweep: (kind: "roster" | "tail") => Effect.Effect<void>;
}

export class AttachedSessions extends Context.Service<AttachedSessions, AttachedSessionsShape>()(
  "t3/attachedSessions/AttachedSessions",
) {}

export interface AttachedSessionsLiveOptions {
  readonly rosterIntervalMs?: number;
  readonly tailIntervalMs?: number;
  readonly readWindowBytes?: number;
}

interface TrackedSession {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  transcriptPath: string | null;
  /** Bytes of the transcript already mirrored. Persisted; reading only moves forward from here. */
  offset: number;
  readonly toolCalls: Map<string, AttachedToolCall>;
  status: OrchestrationSessionStatus | null;
  waitRequestId: string | null;
  endedAt: string | null;
  /**
   * The thread is archived or deleted, so nothing is mirrored into it. The
   * offset stays where it was, and an unarchived thread catches up from there.
   */
  paused: boolean;
}

const SESSION_STATUSES: ReadonlySet<string> = new Set<OrchestrationSessionStatus>([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);

const makeAttachedSessions = (options?: AttachedSessionsLiveOptions) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const query = yield* ProjectionSnapshotQuery;
    const roster = yield* ClaudeAgentsRoster;
    const serverSettings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;
    const directory = yield* ProviderSessionDirectory;

    const rosterIntervalMs = Math.max(1, options?.rosterIntervalMs ?? DEFAULT_ROSTER_INTERVAL_MS);
    const tailIntervalMs = Math.max(1, options?.tailIntervalMs ?? DEFAULT_TAIL_INTERVAL_MS);
    const readWindowBytes = Math.max(1, options?.readWindowBytes ?? READ_WINDOW_BYTES);
    const cursorFilePath = path.join(serverConfig.stateDir, "attached-sessions.json");

    // Sweeps run one at a time on the worker, so plain mutable state is safe.
    // Null until the first sweep loads the cursor file.
    let sessions: Map<string, TrackedSession> | null = null;
    let cursorsDirty = false;
    let configDir: string | null = null;
    let lastRosterSize: number | null = null;

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const loadSessions = Effect.gen(function* () {
      if (sessions !== null) return sessions;
      const cursors = yield* loadAttachedSessionCursors(
        cursorFilePath,
        (yield* DateTime.now).epochMilliseconds,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      sessions = new Map(
        [...cursors].map(([sessionId, cursor]): [string, TrackedSession] => [
          sessionId,
          {
            sessionId,
            threadId: attachedClaudeThreadId(sessionId),
            transcriptPath: cursor.transcriptPath,
            offset: cursor.offset,
            toolCalls: new Map(Object.entries(cursor.toolCalls)),
            status:
              cursor.status !== null && SESSION_STATUSES.has(cursor.status)
                ? (cursor.status as OrchestrationSessionStatus)
                : null,
            waitRequestId: cursor.waitRequestId,
            endedAt: cursor.endedAt,
            paused: false,
          },
        ]),
      );
      return sessions;
    });

    const saveSessions = Effect.suspend(() => {
      if (!cursorsDirty || sessions === null) return Effect.void;
      cursorsDirty = false;
      return saveAttachedSessionCursors(
        cursorFilePath,
        new Map(
          [...sessions].map(([sessionId, session]) => [
            sessionId,
            {
              transcriptPath: session.transcriptPath,
              offset: session.offset,
              status: session.status,
              waitRequestId: session.waitRequestId,
              toolCalls: Object.fromEntries(session.toolCalls),
              endedAt: session.endedAt,
            },
          ]),
        ),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.catch((cause) =>
          Effect.logWarning("attached-sessions.cursor-save-failed", { cause }),
        ),
      );
    });

    const dispatch = (command: OrchestrationCommand) =>
      engine.dispatch(command).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logDebug("attached-sessions.dispatch-rejected", {
            commandType: command.type,
            cause,
          }),
        ),
      );

    const findTranscript = Effect.fn("AttachedSessions.findTranscript")(function* (
      sessionId: string,
    ) {
      if (configDir === null) return null;
      const projectsDir = path.join(configDir, "projects");
      const directories = yield* fileSystem
        .readDirectory(projectsDir)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const directory of directories) {
        const candidate = path.join(projectsDir, directory, `${sessionId}.jsonl`);
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          return candidate;
        }
      }
      return null;
    });

    const transcriptSize = Effect.fn("AttachedSessions.transcriptSize")(function* (
      session: TrackedSession,
    ) {
      session.transcriptPath ??= yield* findTranscript(session.sessionId);
      if (session.transcriptPath === null) return null;
      return yield* fileSystem.stat(session.transcriptPath).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => null),
      );
    });

    /** Reads whole lines appended since the cursor, one window at a time, and advances past them. */
    const readNewEntries = Effect.fn("AttachedSessions.readNewEntries")(function* (
      session: TrackedSession,
    ) {
      const size = yield* transcriptSize(session);
      if (size === null || session.transcriptPath === null) return null;
      if (size < session.offset) {
        // The file was rewritten. What it held is already mirrored, and the
        // backfilled part has no receipts to absorb a re-read, so skip to its end.
        session.offset = size;
        cursorsDirty = true;
        return null;
      }
      if (size === session.offset) return null;

      const chunks = yield* fileSystem
        .stream(session.transcriptPath, {
          offset: session.offset,
          bytesToRead: Math.min(size - session.offset, readWindowBytes),
        })
        .pipe(
          Stream.runCollect,
          Effect.orElseSucceed((): ReadonlyArray<Uint8Array> => []),
        );
      const bytes = Buffer.concat(Array.from(chunks));
      const lastNewline = bytes.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        // No complete line yet, unless one line outgrew the read window: skip it.
        if (bytes.byteLength === readWindowBytes) {
          session.offset += bytes.byteLength;
          cursorsDirty = true;
        }
        return null;
      }
      session.offset += lastNewline + 1;
      cursorsDirty = true;

      const fallbackCreatedAt = yield* nowIso;
      const entries: Array<AttachedTranscriptEntry> = [];
      let gitBranch: string | null = null;
      let model: string | null = null;
      for (const line of bytes.subarray(0, lastNewline).toString("utf8").split("\n")) {
        const parsed = parseAttachedTranscriptLine(line, fallbackCreatedAt);
        if (Option.isNone(parsed)) continue;
        entries.push(...parsed.value.entries);
        gitBranch = parsed.value.gitBranch ?? gitBranch;
        model = parsed.value.model ?? model;
      }
      return { entries, gitBranch, model };
    });

    /**
     * Writes a user message's pasted images into the attachment store. The id is
     * derived from the transcript record, so a re-read finds the same file.
     */
    const persistImages = Effect.fn("AttachedSessions.persistImages")(function* (
      session: TrackedSession,
      entry: Extract<AttachedTranscriptEntry, { kind: "message" }>,
    ) {
      const threadSegment = toSafeThreadAttachmentSegment(session.threadId);
      const attachments: Array<ChatImageAttachment> = [];
      for (const [index, image] of entry.images.entries()) {
        const bytes = Buffer.from(image.base64, "base64");
        if (
          threadSegment === null ||
          !image.mediaType.toLowerCase().startsWith("image/") ||
          bytes.byteLength === 0 ||
          bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ) {
          continue;
        }
        const hash = NodeCrypto.createHash("sha256").update(`${entry.uuid}:${index}`).digest("hex");
        const uuid = [
          hash.slice(0, 8),
          hash.slice(8, 12),
          hash.slice(12, 16),
          hash.slice(16, 20),
          hash.slice(20, 32),
        ].join("-");
        const attachment: ChatImageAttachment = {
          type: "image",
          id: `${threadSegment}-${uuid}`,
          name: `terminal-image-${index + 1}`,
          mimeType: image.mediaType.toLowerCase(),
          sizeBytes: bytes.byteLength,
        };
        const filePath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (filePath === null) continue;
        const written = yield* fileSystem
          .makeDirectory(path.dirname(filePath), { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFile(filePath, bytes)),
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logDebug("attached-sessions.image-write-failed", { cause }).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (written) attachments.push(attachment);
      }
      return attachments;
    });

    const tail = Effect.fn("AttachedSessions.tail")(function* (session: TrackedSession) {
      if (session.paused || session.endedAt !== null) return;
      const read = yield* readNewEntries(session);
      if (read === null) return;
      for (const entry of read.entries) {
        const attachments =
          entry.kind === "message" && entry.images.length > 0
            ? yield* persistImages(session, entry)
            : [];
        const commands = attachedEntryCommands({
          sessionId: session.sessionId,
          threadId: session.threadId,
          entry,
          toolCalls: session.toolCalls,
          attachments,
        });
        yield* Effect.forEach(commands, dispatch, { discard: true });
      }
    });

    const resolveProject = Effect.fn("AttachedSessions.resolveProject")(function* (cwd: string) {
      const exact = yield* query.getActiveProjectByWorkspaceRoot(cwd);
      if (Option.isSome(exact)) return { projectId: exact.value.id, isRoot: true };

      // A session inside a project subdirectory or worktree belongs to that project.
      const { projects } = yield* query.getShellSnapshot();
      const ancestor = projects
        .filter((project) => cwd.startsWith(`${project.workspaceRoot.replace(/\/+$/, "")}/`))
        .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
      if (ancestor !== undefined) return { projectId: ancestor.id, isRoot: false };

      const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`attached:project:${projectId}`),
        projectId,
        title: path.basename(cwd) || "project",
        workspaceRoot: cwd,
        createdAt: yield* nowIso,
      });
      return { projectId, isRoot: true };
    });

    /** First sight of a session this server has no cursor for. */
    const attach = Effect.fn("AttachedSessions.attach")(function* (
      entry: ClaudeAgentsRosterEntry,
      all: Map<string, TrackedSession>,
    ) {
      const session: TrackedSession = {
        sessionId: entry.sessionId,
        threadId: attachedClaudeThreadId(entry.sessionId),
        transcriptPath: null,
        offset: 0,
        toolCalls: new Map(),
        status: null,
        waitRequestId: null,
        endedAt: null,
        paused: false,
      };
      all.set(entry.sessionId, session);
      cursorsDirty = true;
      const size = (yield* transcriptSize(session)) ?? 0;

      const existing = yield* query.getThreadShellById(session.threadId);
      if (Option.isSome(existing)) {
        // The cursor was lost. Nothing says how much of the transcript is already
        // on the thread, so carry on from its end rather than risk repeating it.
        session.offset = size;
        session.status = existing.value.session?.status ?? null;
        if (existing.value.hasPendingApprovals) {
          // Find the wait that is still open, so it can be resolved later.
          const prefix = `attached:${entry.sessionId}:wait:`;
          const detail = yield* query.getThreadDetailById(session.threadId, {
            activityKinds: ["approval.requested", "approval.resolved"],
          });
          const lastWait = Option.getOrUndefined(detail)?.activities.findLast((activity) =>
            activity.id.startsWith(prefix),
          );
          session.waitRequestId =
            lastWait?.kind === "approval.requested"
              ? lastWait.id.slice(0, -":requested".length)
              : null;
        }
        return session;
      }

      session.offset = Math.max(0, size - readWindowBytes);
      const startsMidFile = session.offset > 0;
      const read = yield* readNewEntries(session);
      const entries = read?.entries ?? [];
      // Tools still running at attach time keep their title when they complete.
      for (const item of entries) {
        if (item.kind === "tool-started") {
          session.toolCalls.set(item.toolUseId, { name: item.name, detail: item.detail });
        } else if (item.kind === "tool-completed") {
          session.toolCalls.delete(item.toolUseId);
        }
      }

      const project = yield* resolveProject(entry.cwd);
      const createdAt = yield* nowIso;
      const created = yield* engine
        .dispatch({
          type: "thread.create",
          // Not deterministic: a thread whose cursor expired may be created again.
          commandId: CommandId.make(`attached:${entry.sessionId}:create:${createdAt}`),
          threadId: session.threadId,
          projectId: project.projectId,
          title: `⌁ ${entry.name ?? (path.basename(entry.cwd) || "terminal session")}`,
          modelSelection: {
            instanceId: ATTACHED_CLAUDE_INSTANCE_ID,
            model: read?.model ?? "claude",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: read?.gitBranch ?? null,
          worktreePath: project.isRoot ? null : entry.cwd,
          createdAt,
          historyImport: true,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!created) {
        // An archived thread is invisible to the lookup above but still exists.
        session.paused = true;
        session.offset = size;
        return session;
      }
      const historyImport = attachedHistoryImportCommand({
        sessionId: entry.sessionId,
        threadId: session.threadId,
        entries,
        maxMessages: MAX_BACKFILL_MESSAGES,
        createdAt,
      });
      if (historyImport !== null) yield* dispatch(historyImport);
      yield* Effect.logInfo("attached-sessions.attached", {
        threadId: session.threadId,
        cwd: entry.cwd,
        backfilledFromStart: !startsMidFile,
      });
      return session;
    });

    const applyStatus = Effect.fn("AttachedSessions.applyStatus")(function* (
      session: TrackedSession,
      next: {
        readonly status: OrchestrationSessionStatus;
        readonly waiting: boolean;
        readonly waitingFor: string | null;
      },
    ) {
      const now = yield* nowIso;
      if (session.status !== next.status) {
        yield* dispatch(
          attachedSessionSetCommand({
            sessionId: session.sessionId,
            threadId: session.threadId,
            status: next.status,
            now,
          }),
        );
        session.status = next.status;
        cursorsDirty = true;
      }
      if (next.waiting === (session.waitRequestId !== null)) return;
      const requestId = session.waitRequestId ?? attachedWaitRequestId(session.sessionId, now);
      yield* dispatch(
        attachedWaitCommand({
          sessionId: session.sessionId,
          threadId: session.threadId,
          requestId,
          phase: next.waiting ? "requested" : "resolved",
          waitingFor: next.waitingFor,
          now,
        }),
      );
      session.waitRequestId = next.waiting ? requestId : null;
      cursorsDirty = true;
    });

    /**
     * The session is gone. Its cursor is kept, marked ended, so an archived or
     * deleted thread is not recreated if the session id ever shows up again.
     */
    const end = Effect.fn("AttachedSessions.end")(function* (session: TrackedSession) {
      yield* tail(session);
      // An archived thread still takes this, so it is not left looking busy.
      yield* applyStatus(session, { status: "stopped", waiting: false, waitingFor: null });
      session.toolCalls.clear();
      session.endedAt = yield* nowIso;
      cursorsDirty = true;
    });

    /**
     * Claude sessions that T3 Code is running itself. The roster does not tell
     * them apart from terminal sessions, and mirroring one would duplicate its
     * thread. A stopped binding has no process, so its session id is free to be
     * a terminal session (an imported one, for example).
     */
    const ownedSessionIds = directory.listBindings().pipe(
      Effect.map(
        (bindings) =>
          new Set(
            bindings.flatMap((binding) => {
              const cursor = binding.resumeCursor;
              return binding.status !== "stopped" &&
                typeof cursor === "object" &&
                cursor !== null &&
                "resume" in cursor &&
                typeof cursor.resume === "string"
                ? [cursor.resume]
                : [];
            }),
          ),
      ),
    );

    const rosterSweep = Effect.gen(function* () {
      const all = yield* loadSessions;
      const running = () => [...all.values()].filter((session) => session.endedAt === null);
      const settings = yield* serverSettings.getSettings;
      if (!settings.enableAttachedSessions) {
        // Also covers a server that was restarted with the setting turned off.
        yield* Effect.forEach(running(), end, { discard: true });
        lastRosterSize = null;
        return;
      }
      const snapshot = yield* roster.snapshot;
      if (Option.isNone(snapshot)) return;
      configDir = snapshot.value.configDir;
      lastRosterSize = snapshot.value.sessions.length;

      const owned = yield* ownedSessionIds;
      const live = new Map(
        snapshot.value.sessions
          .filter((entry) => !owned.has(entry.sessionId))
          .map((entry) => [entry.sessionId, entry]),
      );
      for (const session of running()) {
        if (!live.has(session.sessionId)) yield* end(session);
      }
      for (const entry of live.values()) {
        const known = all.get(entry.sessionId);
        if (known !== undefined && known.endedAt !== null) {
          known.endedAt = null;
          cursorsDirty = true;
        }
        const session = known ?? (yield* attach(entry, all));
        // Archived and deleted threads are both invisible here, and both pause the mirror.
        session.paused = Option.isNone(yield* query.getThreadShellById(session.threadId));
        if (session.paused) continue;
        yield* applyStatus(session, {
          status: attachedSessionStatus(entry.status),
          waiting: entry.status === "waiting",
          waitingFor: entry.waitingFor,
        });
      }
    });

    const tailSweep = Effect.suspend(() =>
      Effect.forEach(sessions === null ? [] : [...sessions.values()], tail, { discard: true }),
    );

    // A slow sweep must not let the schedule pile up identical work behind it.
    const queued = new Set<"roster" | "tail">();
    const worker = yield* makeDrainableWorker((kind: "roster" | "tail") =>
      Effect.suspend(() => {
        queued.delete(kind);
        return kind === "roster" ? rosterSweep.pipe(Effect.andThen(tailSweep)) : tailSweep;
      }).pipe(
        Effect.andThen(saveSessions),
        Effect.catch((error: unknown) =>
          Effect.logWarning("attached-sessions.sweep-failed", { kind, error }),
        ),
        Effect.catchDefect((defect: unknown) =>
          Effect.logWarning("attached-sessions.sweep-defect", { kind, defect }),
        ),
      ),
    );

    const sweep: AttachedSessionsShape["sweep"] = (kind) =>
      Effect.suspend(() => {
        if (queued.has(kind)) return Effect.void;
        queued.add(kind);
        return worker.enqueue(kind);
      });

    const start: AttachedSessionsShape["start"] = () =>
      Effect.gen(function* () {
        // Each probe spawns the CLI. With no terminal sessions around there is
        // nothing to keep current, so look for new ones less often.
        let skippedProbes = 0;
        yield* forkParked(
          Effect.suspend(() => {
            if (lastRosterSize === 0 && skippedProbes < EMPTY_ROSTER_SKIPPED_PROBES) {
              skippedProbes += 1;
              return Effect.void;
            }
            skippedProbes = 0;
            return sweep("roster");
          }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(rosterIntervalMs)))),
        );
        yield* forkParked(
          Effect.suspend(() =>
            sessions !== null &&
            [...sessions.values()].some((session) => session.endedAt === null && !session.paused)
              ? sweep("tail")
              : Effect.void,
          ).pipe(Effect.repeat(Schedule.spaced(Duration.millis(tailIntervalMs)))),
        );
      });

    return AttachedSessions.of({ start, drain: worker.drain, sweep });
  });

export const makeLayer = (options?: AttachedSessionsLiveOptions) =>
  Layer.effect(AttachedSessions, makeAttachedSessions(options));

export const layer = makeLayer();
