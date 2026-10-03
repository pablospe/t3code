/**
 * Mirrors Claude CLI sessions that run outside T3 Code into threads.
 *
 * The terminal stays the only owner of the session. This service only observes:
 * it polls the CLI roster for which sessions exist and what they are doing, and
 * tails each session's transcript for the conversation. The conversation is
 * written as runless V2 events straight to the event sink, the way the agent
 * session importer does; the marker and the session's activity go through the
 * orchestrator so they serialize with the user's commands on the thread. It
 * and never creates a run, provider thread or provider session, so nothing in
 * T3 tries to start, resume or recover these threads. Messages typed in T3 reach
 * the session through AttachedSessionSender.
 *
 * A Claude session id belongs to one thread only. A session T3 drives, or one
 * the agent session importer took over, has a provider thread derived from its
 * id, and the mirror skips it; the importer in turn skips sessions this mirror
 * already covers (#10933).
 */
import * as NodeCrypto from "node:crypto";

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatImageAttachment,
  CommandId,
  ProjectId,
  attachedClaudeThreadId,
  isExternalSessionThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
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
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ATTACHED_ACTIVITY_STATUSES,
  CLAUDE_DRIVER,
  attachedBackfillEvents,
  attachedEntryEvents,
  attachedActivityStatus,
  attachedThread,
  attachedToolEvent,
  type AttachedEventDraft,
  type AttachedActivityStatus,
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
import {
  ClaudeAgentsRoster,
  isClaudeMemObserverSession,
  type ClaudeAgentsRosterEntry,
} from "./ClaudeAgentsRoster.ts";

const DEFAULT_ROSTER_INTERVAL_MS = 5_000;
const DEFAULT_TAIL_INTERVAL_MS = 1_500;
// The most one read takes in, and how far back a first attach looks for history.
// A larger backlog is caught up over the following sweeps.
const READ_WINDOW_BYTES = 8 * 1024 * 1024;
// An empty roster is probed every sixth tick (30s by default) instead of every tick.
const EMPTY_ROSTER_SKIPPED_PROBES = 5;
const MAX_BACKFILL_MESSAGES = 200;
const NEWLINE = 0x0a;

interface AttachedSessionsShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once every queued sweep has been processed. */
  readonly drain: Effect.Effect<void>;
  /** Queue one sweep now instead of waiting for the schedule. */
  readonly sweep: (kind: "roster" | "tail") => Effect.Effect<void>;
}

export class AttachedSessions extends Context.Service<AttachedSessions, AttachedSessionsShape>()(
  "t3/attachedSessions/AttachedSessions",
) {}

interface AttachedSessionsLiveOptions {
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
  status: AttachedActivityStatus | null;
  waitingFor: string | null;
  workStartedAt: string | null;
  endedAt: string | null;
  /**
   * The thread is archived or deleted, so nothing is mirrored into it. The
   * offset stays where it was, and an unarchived thread catches up from there.
   */
  paused: boolean;
  /** The thread was settled out of the active list because its session left the roster. */
  settled: boolean;
  /** Not persisted: whether a thread imported from V1 has its history in place. */
  historyReady: boolean;
}

const isActiveStatus = (status: AttachedActivityStatus | null) =>
  status === "running" || status === "waiting";

const makeAttachedSessions = (options?: AttachedSessionsLiveOptions) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projects = yield* ProjectService.ProjectService;
    const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const roster = yield* ClaudeAgentsRoster;
    const serverSettings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;

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
    // Sessions T3 runs itself never become attached sessions, so one lookup each is enough.
    const ownedByT3 = new Set<string>();

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const loadThread = (threadId: ThreadId) =>
      orchestrator.getThreadRecords(threadId, []).pipe(
        Effect.map((records) => records.thread),
        Effect.option,
      );

    /** Ids are allocated here because the event log keeps every write. */
    const write = (threadId: ThreadId, drafts: ReadonlyArray<AttachedEventDraft>) =>
      Effect.gen(function* () {
        if (drafts.length === 0) return;
        const events = yield* Effect.forEach(drafts, (draft) =>
          idAllocator.allocate
            .event({ threadId })
            .pipe(Effect.map((id) => ({ ...draft, id }) as OrchestrationV2DomainEvent)),
        );
        yield* eventSink.write({ events });
      });

    /** Writes the marker and activity through the orchestrator, serialized with the user's commands. */
    const updateExternalSession = (
      session: TrackedSession,
      activity: NonNullable<OrchestrationV2AppThread["externalSession"]>["activity"],
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        yield* orchestrator.dispatch({
          type: "thread.external-session.update",
          commandId: CommandId.make(
            `attached:${session.sessionId}:activity:${now}:${activity?.status ?? "adopt"}`,
          ),
          threadId: session.threadId,
          externalSession: {
            driver: CLAUDE_DRIVER,
            nativeSessionId: session.sessionId,
            ...(activity === undefined ? {} : { activity }),
          },
        });
      });

    /**
     * Threads the V1 mirror created were imported as plain V1 history. Marking
     * them as external sessions puts them under the same rules as new ones.
     */
    const adoptLegacyThread = Effect.fn("AttachedSessions.adoptLegacyThread")(function* (
      session: TrackedSession,
      thread: OrchestrationV2AppThread,
    ) {
      if (isExternalSessionThread(thread)) return;
      yield* updateExternalSession(session, null);
      // The V1 status values mean nothing here; write the activity again.
      session.status = null;
      cursorsDirty = true;
      yield* Effect.logInfo("attached-sessions.adopted", { threadId: session.threadId });
    });

    const loadSessions = Effect.gen(function* () {
      if (sessions !== null) return sessions;
      const cursors = yield* loadAttachedSessionCursors(
        cursorFilePath,
        (yield* DateTime.now).epochMilliseconds,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      const loaded = new Map(
        [...cursors].map(([sessionId, cursor]): [string, TrackedSession] => [
          sessionId,
          {
            sessionId,
            threadId: attachedClaudeThreadId(sessionId),
            transcriptPath: cursor.transcriptPath,
            offset: cursor.offset,
            toolCalls: new Map(Object.entries(cursor.toolCalls)),
            status:
              cursor.status !== null && ATTACHED_ACTIVITY_STATUSES.has(cursor.status)
                ? (cursor.status as AttachedActivityStatus)
                : null,
            waitingFor: cursor.waitingFor ?? null,
            workStartedAt: cursor.workStartedAt ?? null,
            endedAt: cursor.endedAt,
            paused: false,
            settled: cursor.settled ?? false,
            historyReady: false,
          },
        ]),
      );
      for (const session of loaded.values()) {
        const thread = yield* loadThread(session.threadId);
        if (Option.isSome(thread)) yield* adoptLegacyThread(session, thread.value);
      }
      sessions = loaded;
      return loaded;
    });

    const saveSessions = Effect.suspend(() => {
      if (!cursorsDirty || sessions === null) return Effect.void;
      return saveAttachedSessionCursors(
        cursorFilePath,
        new Map(
          [...sessions].map(([sessionId, session]) => [
            sessionId,
            {
              transcriptPath: session.transcriptPath,
              offset: session.offset,
              status: session.status,
              waitingFor: session.waitingFor,
              workStartedAt: session.workStartedAt,
              toolCalls: Object.fromEntries(session.toolCalls),
              endedAt: session.endedAt,
              settled: session.settled,
            },
          ]),
        ),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        // Still dirty after a failed write, so the next sweep tries again.
        Effect.andThen(
          Effect.sync(() => {
            cursorsDirty = false;
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("attached-sessions.cursor-save-failed", { cause }),
        ),
      );
    });

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

    /**
     * Reads whole lines appended since the cursor, one window at a time. The
     * caller moves the cursor to `nextOffset` once the entries are written.
     */
    const readNewEntries = Effect.fn("AttachedSessions.readNewEntries")(function* (
      session: TrackedSession,
    ) {
      const size = yield* transcriptSize(session);
      if (size === null || session.transcriptPath === null) return null;
      if (size < session.offset) {
        // The file was rewritten. What it held is already mirrored, so skip to its end.
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
      return { entries, gitBranch, model, nextOffset: session.offset + lastNewline + 1 };
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

    /** A thread imported from V1 gets its old history in place before anything is added after it. */
    const ensureHistory = Effect.fn("AttachedSessions.ensureHistory")(function* (
      session: TrackedSession,
    ) {
      if (session.historyReady) return;
      yield* legacyImporter.ensureTranscript(session.threadId);
      session.historyReady = true;
    });

    const tail = Effect.fn("AttachedSessions.tail")(function* (session: TrackedSession) {
      if (session.paused || session.endedAt !== null) return;
      const read = yield* readNewEntries(session);
      if (read === null) return;
      yield* ensureHistory(session);
      let ordinal = yield* projectionStore.getNextTurnItemOrdinal(session.threadId);
      const drafts: Array<AttachedEventDraft> = [];
      for (const entry of read.entries) {
        const attachments =
          entry.kind === "message" && entry.images.length > 0
            ? yield* persistImages(session, entry)
            : [];
        drafts.push(
          ...attachedEntryEvents({
            sessionId: session.sessionId,
            threadId: session.threadId,
            entry,
            toolCalls: session.toolCalls,
            attachments,
            nextOrdinal: () => ordinal++,
          }),
        );
      }
      yield* write(session.threadId, drafts);
      session.offset = read.nextOffset;
      cursorsDirty = true;
    });

    const resolveProject = Effect.fn("AttachedSessions.resolveProject")(function* (cwd: string) {
      const exact = yield* projects.getByWorkspaceRoot(cwd);
      if (Option.isSome(exact)) return { projectId: exact.value.id, isRoot: true };

      // A session inside a project subdirectory or worktree belongs to that project.
      const ancestor = (yield* projects.listShells())
        .filter((project) => cwd.startsWith(`${project.workspaceRoot.replace(/\/+$/, "")}/`))
        .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
      if (ancestor !== undefined) return { projectId: ancestor.id, isRoot: false };

      const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
      const project = yield* projects.create({
        commandId: CommandId.make(`attached:project:${projectId}`),
        projectId,
        title: path.basename(cwd) || "project",
        workspaceRoot: cwd,
      });
      return { projectId: project.id, isRoot: true };
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
        waitingFor: null,
        workStartedAt: null,
        endedAt: null,
        paused: false,
        settled: false,
        historyReady: false,
      };
      all.set(entry.sessionId, session);
      cursorsDirty = true;
      const size = (yield* transcriptSize(session)) ?? 0;

      const existing = yield* loadThread(session.threadId);
      if (Option.isSome(existing)) {
        // The cursor was lost. Nothing says how much of the transcript is already
        // on the thread, so carry on from its end rather than risk repeating it.
        session.offset = size;
        yield* adoptLegacyThread(session, existing.value);
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
      const now = yield* nowIso;
      const thread = attachedThread({
        sessionId: entry.sessionId,
        threadId: session.threadId,
        projectId: project.projectId,
        title: `⌁ ${entry.name ?? (path.basename(entry.cwd) || "terminal session")}`,
        model: read?.model ?? null,
        branch: read?.gitBranch ?? null,
        worktreePath: project.isRoot ? null : entry.cwd,
        now,
      });
      yield* write(session.threadId, [
        {
          type: "thread.created",
          threadId: session.threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.createdAt,
          payload: thread,
        },
        ...attachedBackfillEvents({
          sessionId: entry.sessionId,
          threadId: session.threadId,
          entries,
          maxMessages: MAX_BACKFILL_MESSAGES,
          firstOrdinal: 1,
        }),
      ]);
      session.offset = read?.nextOffset ?? session.offset;
      session.historyReady = true;
      yield* Effect.logInfo("attached-sessions.attached", {
        threadId: session.threadId,
        cwd: entry.cwd,
        backfilledFromStart: !startsMidFile,
      });
      return session;
    });

    const applyStatus = Effect.fn("AttachedSessions.applyStatus")(function* (
      session: TrackedSession,
      status: AttachedActivityStatus,
      waitingFor: string | null = null,
    ) {
      const reason = status === "waiting" ? waitingFor : null;
      if (session.status === status && session.waitingFor === reason) return;
      const now = yield* nowIso;
      if (isActiveStatus(status) && !isActiveStatus(session.status)) {
        session.workStartedAt = now;
      }
      yield* updateExternalSession(session, {
        status,
        waitingReason: reason,
        workStartedAt: session.workStartedAt,
      });
      session.status = status;
      session.waitingFor = reason;
      cursorsDirty = true;
    });

    /**
     * The session is gone. Its cursor is kept, marked ended, so an archived or
     * deleted thread is not recreated if the session id ever shows up again.
     */
    const end = Effect.fn("AttachedSessions.end")(function* (session: TrackedSession) {
      if (!session.paused) yield* tail(session);
      // An archived thread still takes this, so it is not left looking busy.
      const thread = yield* loadThread(session.threadId);
      if (Option.isSome(thread) && thread.value.deletedAt === null) {
        // Tools the session never finished must not keep spinning.
        const now = yield* nowIso;
        yield* write(
          session.threadId,
          [...session.toolCalls].flatMap(([toolUseId, tool]) =>
            tool.ordinal === undefined
              ? []
              : [
                  attachedToolEvent({
                    sessionId: session.sessionId,
                    threadId: session.threadId,
                    toolUseId,
                    tool,
                    ordinal: tool.ordinal,
                    status: "interrupted",
                    startedAt: now,
                    completedAt: now,
                  }),
                ],
          ),
        );
        yield* applyStatus(session, "ended");
      }
      session.toolCalls.clear();
      session.endedAt = yield* nowIso;
      cursorsDirty = true;
    });

    /** Drops a thread out of the active list once its session has left the roster. */
    const settleThread = Effect.fn("AttachedSessions.settleThread")(function* (
      session: TrackedSession,
    ) {
      yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(
            `attached:${session.sessionId}:settle:${session.endedAt ?? "ended"}`,
          ),
          threadId: session.threadId,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logDebug("attached-sessions.settle-rejected", {
              threadId: session.threadId,
              cause,
            }),
          ),
        );
      session.settled = true;
      cursorsDirty = true;
    });

    const unsettleThread = Effect.fn("AttachedSessions.unsettleThread")(function* (
      session: TrackedSession,
    ) {
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`attached:${session.sessionId}:unsettle:${yield* nowIso}`),
        threadId: session.threadId,
        // The user resumed the session in the terminal.
        reason: "user",
      });
      session.settled = false;
      cursorsDirty = true;
    });

    const isOwnedByT3 = Effect.fn("AttachedSessions.isOwnedByT3")(function* (sessionId: string) {
      if (ownedByT3.has(sessionId)) return true;
      const owner = yield* projectionStore.getProviderThreadOwner(
        IdAllocator.deriveProviderThread({ driver: CLAUDE_DRIVER, nativeThreadId: sessionId }),
      );
      if (owner !== null) ownedByT3.add(sessionId);
      return owner !== null;
    });

    /** One session's failure is logged and retried next sweep without holding up the others. */
    const isolated = <E>(session: TrackedSession, effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("attached-sessions.session-failed", {
            sessionId: session.sessionId,
            cause,
          }),
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

      const live = new Map<string, ClaudeAgentsRosterEntry>();
      for (const entry of snapshot.value.sessions) {
        // claude-mem's observer sessions are not agents the user drives, and a
        // session T3 runs or took over already has its own thread.
        if (isClaudeMemObserverSession(entry.cwd)) continue;
        if (!all.has(entry.sessionId) && (yield* isOwnedByT3(entry.sessionId))) continue;
        live.set(entry.sessionId, entry);
      }
      for (const session of running()) {
        if (!live.has(session.sessionId)) yield* isolated(session, end(session));
      }
      // Guarded by `settled` so the stale backlog clears once and is never
      // re-settled every sweep.
      for (const session of all.values()) {
        if (!live.has(session.sessionId) && !session.settled) {
          yield* isolated(session, settleThread(session));
        }
      }
      for (const entry of live.values()) {
        const known = all.get(entry.sessionId);
        // Resumed in the terminal: the thread comes back to the active list.
        const resumed = known !== undefined && known.endedAt !== null;
        if (resumed) {
          known.endedAt = null;
          cursorsDirty = true;
        }
        yield* Effect.gen(function* () {
          const session =
            known ??
            (yield* attach(entry, all).pipe(
              // Nothing was created, so the next sweep attaches from scratch.
              Effect.tapError(() => Effect.sync(() => all.delete(entry.sessionId))),
            ));
          const thread = yield* loadThread(session.threadId);
          session.paused = Option.match(thread, {
            onNone: () => true,
            onSome: (value) => value.archivedAt !== null || value.deletedAt !== null,
          });
          if (session.paused) return;
          if (resumed && session.settled) yield* unsettleThread(session);
          yield* applyStatus(session, attachedActivityStatus(entry.status), entry.waitingFor);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("attached-sessions.session-failed", {
              sessionId: entry.sessionId,
              cause,
            }),
          ),
        );
      }
    });

    const tailSweep = Effect.suspend(() =>
      Effect.forEach(
        sessions === null ? [] : [...sessions.values()],
        (session) => isolated(session, tail(session)),
        { discard: true },
      ),
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
          Effect.logWarning("attached-sessions.sweep-failed", { kind, error }).pipe(
            Effect.andThen(saveSessions),
          ),
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
