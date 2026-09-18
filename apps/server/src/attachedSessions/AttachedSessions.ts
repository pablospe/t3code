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
  isAttachedSessionThreadId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
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
import { ClaudeAgentsRoster, type ClaudeAgentsRosterEntry } from "./ClaudeAgentsRoster.ts";

const DEFAULT_ROSTER_INTERVAL_MS = 5_000;
const DEFAULT_TAIL_INTERVAL_MS = 1_500;
// How far back a first attach, or a catch-up after a server restart, reads.
const BACKFILL_BYTES = 8 * 1024 * 1024;
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
}

interface TrackedSession {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  transcriptPath: string | null;
  offset: number;
  /** Entries already on the thread. Only needed for the first catch-up read. */
  seen: Set<string> | null;
  readonly toolCalls: Map<string, AttachedToolCall>;
  status: OrchestrationSessionStatus | null;
  waitRequestId: string | null;
  /** The user archived or deleted the thread, so the mirror is paused. */
  suppressed: boolean;
}

const entryKey = (entry: AttachedTranscriptEntry) =>
  entry.kind === "message"
    ? entry.uuid
    : `${entry.toolUseId}:${entry.kind === "tool-started" ? "started" : "completed"}`;

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

    const rosterIntervalMs = Math.max(1, options?.rosterIntervalMs ?? DEFAULT_ROSTER_INTERVAL_MS);
    const tailIntervalMs = Math.max(1, options?.tailIntervalMs ?? DEFAULT_TAIL_INTERVAL_MS);

    // Sweeps run one at a time on the worker, so plain mutable state is safe.
    const tracked = new Map<string, TrackedSession>();
    const dismissed = new Set<string>();
    let configDir: string | null = null;
    let reconciledStoppedThreads = false;

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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

    /** Reads whole lines appended since `offset` and advances past them. */
    const readNewEntries = Effect.fn("AttachedSessions.readNewEntries")(function* (
      session: TrackedSession,
    ) {
      session.transcriptPath ??= yield* findTranscript(session.sessionId);
      if (session.transcriptPath === null) return null;
      const size = yield* fileSystem.stat(session.transcriptPath).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => null),
      );
      if (size === null) return null;
      // A shorter file was rewritten. Deterministic ids make re-reading it safe.
      if (size < session.offset) session.offset = 0;
      if (size === session.offset) return null;

      const chunks = yield* fileSystem
        .stream(session.transcriptPath, {
          offset: session.offset,
          bytesToRead: Math.min(size - session.offset, BACKFILL_BYTES),
        })
        .pipe(
          Stream.runCollect,
          Effect.orElseSucceed((): ReadonlyArray<Uint8Array> => []),
        );
      const bytes = Buffer.concat(Array.from(chunks));
      const lastNewline = bytes.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        // No complete line yet, unless one line outgrew the read window: skip it.
        if (bytes.byteLength === BACKFILL_BYTES) session.offset += bytes.byteLength;
        return null;
      }
      session.offset += lastNewline + 1;

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
      if (session.suppressed) return;
      const read = yield* readNewEntries(session);
      if (read === null) return;
      const seen = session.seen;
      session.seen = null;
      for (const entry of read.entries) {
        if (seen?.has(entryKey(entry))) continue;
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

    const track = Effect.fn("AttachedSessions.track")(function* (sessionId: string) {
      const session: TrackedSession = {
        sessionId,
        threadId: attachedClaudeThreadId(sessionId),
        transcriptPath: yield* findTranscript(sessionId),
        offset: 0,
        seen: null,
        toolCalls: new Map(),
        status: null,
        waitRequestId: null,
        suppressed: false,
      };
      if (session.transcriptPath !== null) {
        const size = yield* fileSystem.stat(session.transcriptPath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        session.offset = Math.max(0, size - BACKFILL_BYTES);
      }
      tracked.set(sessionId, session);
      return session;
    });

    /** Picks a mirror back up after a server restart without repeating what is already there. */
    const resume = (session: TrackedSession, thread: OrchestrationThread) => {
      const prefix = `attached:${session.sessionId}:`;
      session.suppressed = thread.archivedAt !== null;
      session.status = thread.session?.status ?? null;
      session.seen = new Set(
        [...thread.messages, ...thread.activities].map((item) => item.id.slice(prefix.length)),
      );
      const lastWait = thread.activities.findLast(
        (activity) =>
          activity.kind.startsWith("approval.") && activity.id.startsWith(`${prefix}wait:`),
      );
      session.waitRequestId =
        lastWait?.kind === "approval.requested" ? lastWait.id.slice(0, -":requested".length) : null;
    };

    const attach = Effect.fn("AttachedSessions.attach")(function* (entry: ClaudeAgentsRosterEntry) {
      const session = yield* track(entry.sessionId);
      const { threadId } = session;
      const startsMidFile = session.offset > 0;

      const existing = yield* query.getThreadDetailById(threadId);
      if (Option.isSome(existing)) {
        resume(session, existing.value);
        return session;
      }
      if (dismissed.has(entry.sessionId)) {
        session.suppressed = true;
        return session;
      }

      const read = yield* readNewEntries(session);
      // The first line of a mid-file read is a fragment, and it never decodes.
      const entries = read?.entries ?? [];
      const project = yield* resolveProject(entry.cwd);
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.create",
        // Not deterministic: a deleted thread may be recreated after a restart.
        commandId: CommandId.make(`attached:${entry.sessionId}:create:${createdAt}`),
        threadId,
        projectId: project.projectId,
        title: `⌁ ${entry.name ?? (path.basename(entry.cwd) || "terminal session")}`,
        modelSelection: { instanceId: ATTACHED_CLAUDE_INSTANCE_ID, model: read?.model ?? "claude" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: read?.gitBranch ?? null,
        worktreePath: project.isRoot ? null : entry.cwd,
        createdAt,
        historyImport: true,
      });
      const historyImport = attachedHistoryImportCommand({
        sessionId: entry.sessionId,
        threadId,
        entries,
        maxMessages: MAX_BACKFILL_MESSAGES,
      });
      if (historyImport !== null) yield* dispatch(historyImport);
      yield* Effect.logInfo("attached-sessions.attached", {
        threadId,
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
    });

    const end = Effect.fn("AttachedSessions.end")(function* (session: TrackedSession) {
      tracked.delete(session.sessionId);
      if (session.suppressed) return;
      yield* tail(session);
      yield* applyStatus(session, { status: "stopped", waiting: false, waitingFor: null });
    });

    /** Threads left running by a previous server run whose session is gone now. */
    const stopOrphanedThreads = Effect.fn("AttachedSessions.stopOrphanedThreads")(function* (
      liveThreadIds: ReadonlySet<string>,
    ) {
      const { threads } = yield* query.getShellSnapshot();
      for (const thread of threads) {
        if (!isAttachedSessionThreadId(thread.id) || liveThreadIds.has(thread.id)) continue;
        if (thread.session === null || thread.session.status === "stopped") continue;
        const detail = yield* query.getThreadDetailById(thread.id);
        if (Option.isNone(detail)) continue;
        const session = yield* track(thread.id.slice(attachedClaudeThreadId("").length));
        resume(session, detail.value);
        yield* end(session);
      }
    });

    const rosterSweep = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.enableAttachedSessions) {
        yield* Effect.forEach([...tracked.values()], end, { discard: true });
        return;
      }
      const snapshot = yield* roster.snapshot;
      if (Option.isNone(snapshot)) return;
      configDir = snapshot.value.configDir;

      const live = new Map(snapshot.value.sessions.map((entry) => [entry.sessionId, entry]));
      for (const session of tracked.values()) {
        if (!live.has(session.sessionId)) yield* end(session);
      }
      if (!reconciledStoppedThreads) {
        reconciledStoppedThreads = true;
        yield* stopOrphanedThreads(
          new Set([...live.keys()].map((sessionId) => attachedClaudeThreadId(sessionId))),
        );
      }
      for (const entry of live.values()) {
        let session = tracked.get(entry.sessionId);
        if (session !== undefined) {
          // Archive, unarchive and delete all change whether the mirror should run.
          const shell = yield* query.getThreadShellById(session.threadId);
          if (Option.isNone(shell)) {
            dismissed.add(entry.sessionId);
            session.suppressed = true;
          } else if (session.suppressed !== (shell.value.archivedAt !== null)) {
            session = undefined;
          }
        }
        session ??= yield* attach(entry);
        if (session.suppressed) continue;
        yield* applyStatus(session, {
          status: attachedSessionStatus(entry.status),
          waiting: entry.status === "waiting",
          waitingFor: entry.waitingFor,
        });
      }
    });

    const tailSweep = Effect.suspend(() =>
      Effect.forEach([...tracked.values()], tail, { discard: true }),
    );

    // A slow sweep must not let the schedule pile up identical work behind it.
    const queued = new Set<"roster" | "tail">();
    const worker = yield* makeDrainableWorker((kind: "roster" | "tail") =>
      Effect.suspend(() => {
        queued.delete(kind);
        return kind === "roster" ? rosterSweep.pipe(Effect.andThen(tailSweep)) : tailSweep;
      }).pipe(
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
        yield* forkParked(
          sweep("roster").pipe(Effect.repeat(Schedule.spaced(Duration.millis(rosterIntervalMs)))),
        );
        yield* forkParked(
          Effect.suspend(() => (tracked.size === 0 ? Effect.void : sweep("tail"))).pipe(
            Effect.repeat(Schedule.spaced(Duration.millis(tailIntervalMs))),
          ),
        );
      });

    return AttachedSessions.of({ start, drain: worker.drain, sweep });
  });

export const makeLayer = (options?: AttachedSessionsLiveOptions) =>
  Layer.effect(AttachedSessions, makeAttachedSessions(options));

export const layer = makeLayer();
