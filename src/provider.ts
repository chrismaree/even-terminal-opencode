// OpenCode provider for the even-terminal wire contract, backed by OpenChamber.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import type {
  EvenMessage,
  EvenProvider,
  EvenSession,
  HistoryItem,
  ProviderInfo,
} from "./types.ts";
import { MessageHub } from "./hub.ts";
import { OpenChamberClient, type OcMessage, type OcSession } from "./openchamber.ts";
import { connectUpstream, type UpstreamEvent } from "./sse.ts";
import { DeltaCoalescer } from "./throttle.ts";
import {
  OpencodeEventTranslator,
  decisionToResponse,
  lastAssistantText,
  lastAssistantUsage,
  parseQuestionAnswer,
  permissionRequestMessage,
  projectLabelFor,
  questionMessage,
  sessionState,
  toEvenSession,
  toHistoryRows,
  visibleRootSessions,
  type OcProject,
} from "./translate.ts";

// The Even app filters its session list to known providers, so we present
// as "claude" on the wire (same trick even-terminal-pi uses).
export const PROVIDER_NAME = "claude";

const MERGE_TTL_MS = 5_000;
const SYNC_INTERVAL_MS = 30_000;
const RUNNING_STATS_INTERVAL_MS = 10_000;

export interface OpencodeProviderOptions {
  oc: OpenChamberClient;
  hub: MessageHub;
  /** Upstream OpenChamber global event URL (GET /api/global/event). */
  eventUrl: string;
  hostLabel?: string;
  mergeTtlMs?: number;
  /** prefix session titles with their project label (default true) */
  prefixTitles?: boolean;
  /** OpenChamber settings.json path for project aliases (default ~/.config/openchamber/settings.json) */
  settingsPath?: string;
  /** pinned directory for new glasses sessions (default: projectless chat) */
  newSessionDir?: string;
  /** session registry path (default ~/.config/openchamber/terminal-bridge-sessions.json) */
  registryPath?: string;
  /** emit tool cards for read-only tools too (default: quiet summaries only) */
  verboseTools?: boolean;
}

interface PendingAsk {
  requestId: string;
  sessionId: string;
  directory?: string;
  toolName: string;
  description: string;
  questions: Array<{ question?: string; header?: string }>;
  /** "event" = live stream (cleared by replied events); "snapshot" = REST */
  source: "event" | "snapshot";
}

export function createOpencodeProvider(
  opts: OpencodeProviderOptions,
): EvenProvider & { start: () => void; stop: () => void; syncNow: () => Promise<void> } {
  const { oc, hub, eventUrl } = opts;
  const mergeTtlMs = opts.mergeTtlMs ?? MERGE_TTL_MS;

  // ── tracked state (all bounded) ───────────────────────
  const knownSessions = new Map<string, OcSession>();
  const activity: Record<string, { type: string }> = {};
  /** persisted registry path — projectless sessions must survive restarts */
  const registryPath = opts.registryPath ?? `${homedir()}/.config/openchamber/terminal-bridge-sessions.json`;
  let registryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Load the persisted session registry (survives bridge restarts). */
  async function loadRegistry(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(registryPath, "utf8")) as OcSession[];
      for (const s of Array.isArray(raw) ? raw : []) {
        if (s?.id && !knownSessions.has(s.id)) knownSessions.set(s.id, s);
      }
    } catch {
      // first run or unreadable — empty registry
    }
  }

  /** Persist the registry (debounced) so restarts never orphan sessions. */
  function schedulePersist(): void {
    if (registryTimer) return;
    registryTimer = setTimeout(() => {
      registryTimer = null;
      void persistRegistry();
    }, 500);
  }

  async function persistRegistry(): Promise<void> {
    try {
      const dir = registryPath.slice(0, registryPath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      const cutoff = Date.now() - 30 * 24 * 3600_000;
      const entries = [...knownSessions.values()]
        .filter((s) => !s.time?.archived && (s.time?.updated ?? 0) > cutoff)
        .slice(0, 2000);
      await writeFile(registryPath, JSON.stringify(entries));
    } catch {
      // best effort
    }
  }


  // pending asks keyed by requestId — a session can have several at once
  const pendingPermission = new Map<string, PendingAsk>();
  const pendingQuestion = new Map<string, PendingAsk>();
  /** `${kind}:${sessionId}` -> FIFO requestIds */
  const askQueues = new Map<string, string[]>();
  const busySessions = new Set<string>();
  /** sessionId -> turn start (for running_stats duration) */
  const busySince = new Map<string, number>();
  /** sessionId -> last known usage from message.updated events (for running_stats) */
  const usageCache = new Map<string, { input: number; output: number; cost: number }>();

  const translator = new OpencodeEventTranslator("", opts.verboseTools ?? false);
  let upstream: { abort: () => void } | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  function emit(sessionId: string, msg: EvenMessage): void {
    // keep delta ordering: flush buffered text before any other message
    if (msg.type !== "text_delta") coalescer.flush(sessionId);
    hub.emit(sessionId, msg);
  }

  const coalescer = new DeltaCoalescer((sessionId, text) => {
    hub.emit(sessionId, { type: "text_delta", text });
  });

  function trackStatus(sessionId: string, state: string): void {
    if (state === "busy") {
      busySessions.add(sessionId);
      if (!busySince.has(sessionId)) busySince.set(sessionId, Date.now());
      startStatsTimer();
    }
    if (state === "idle") {
      busySessions.delete(sessionId);
      busySince.delete(sessionId);
    }
  }

  /** Live token/duration tick per busy session, mirroring upstream's cadence. */
  function emitRunningStats(): void {
    if (busySessions.size === 0) {
      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
      return;
    }
    for (const sessionId of busySessions) {
      const startedAt = busySince.get(sessionId);
      const usage = usageCache.get(sessionId);
      emit(sessionId, {
        type: "running_stats",
        durationMs: startedAt ? Date.now() - startedAt : 0,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
      });
    }
  }

  function startStatsTimer(): void {
    if (statsTimer) return;
    statsTimer = setInterval(emitRunningStats, RUNNING_STATS_INTERVAL_MS);
  }

  function rec(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  }

  function str(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  /** Cache usage from message.updated events for running_stats. */
  function trackUsage(event: UpstreamEvent): void {
    const props = event.properties ?? {};
    const info = rec(props.info);
    const sessionId = str(info.sessionID);
    if (!sessionId) return;
    if (str(info.role) !== "assistant") return;
    const tokens = rec(info.tokens);
    usageCache.set(sessionId, {
      input: typeof tokens.input === "number" ? tokens.input : 0,
      output: typeof tokens.output === "number" ? tokens.output : 0,
      cost: typeof info.cost === "number" ? info.cost : 0,
    });
    if (usageCache.size > 128) {
      const first = usageCache.keys().next().value;
      if (first !== undefined) usageCache.delete(first);
    }
  }

  function handleUpstreamEvent(event: UpstreamEvent): void {
    if (event.type === "message.updated") trackUsage(event);
    for (const translated of translator.translate(event)) {
      const { sessionId, msg } = translated;
      if (translated.reply) {
        // answered elsewhere (OpenChamber UI / auto-accept): clear + hint only
        // if the ask was visible on the glasses
        const pending = pendingByKind(translated.reply.kind).get(translated.reply.requestId);
        clearPending(translated.reply.kind, sessionId, translated.reply.requestId);
        if (pending) emit(sessionId, translated.msg);
        continue;
      }
      if (translated.ask) {
        trackAsk(translated);
        if (translated.msg.type === "user_question") {
          const q = translated.msg as { questions: Array<{ question: string }> };
          emit(sessionId, {
            type: "notification",
            title: "Agent asks",
            message: q.questions[0]?.question?.slice(0, 120) || "Agent has a question",
          });
        }
      }
      if (msg.type === "status") {
        trackStatus(sessionId, msg.state);
        if (msg.state === "idle") {
          busySessions.delete(sessionId);
          coalescer.flush(sessionId); // deltas land before the result
          for (const closed of translator.closeBlock(sessionId)) {
            emit(closed.sessionId, closed.msg);
          }
          void emitIdleResult(sessionId); // result message doubles as idle signal
          continue;
        }
      }
      emit(sessionId, msg);
    }
    if (event.type === "permission.asked" || event.type === "question.asked") {
      scheduleAskResync(); // catch auto-accept filtered siblings via REST
    }
  }

  /** Store the request id so ring replies know where to POST. */
  function trackAsk(t: {
    sessionId: string;
    msg: EvenMessage;
    ask?: { kind: "permission" | "question"; requestId: string; questions: Array<{ question?: string; header?: string }> };
  }): void {
    if (!t.ask) return;
    const map = pendingByKind(t.ask.kind);
    if (!map.has(t.ask.requestId)) pushAskQueue(t.ask.kind, t.sessionId, t.ask.requestId);
    map.set(t.ask.requestId, {
      requestId: t.ask.requestId,
      sessionId: t.sessionId,
      directory: knownSessions.get(t.sessionId)?.directory,
      toolName: t.msg.type === "permission_request" ? (t.msg as { toolName: string }).toolName : "question",
      description:
        t.msg.type === "permission_request"
          ? (t.msg as { description: string }).description
          : "Agent has a question",
      questions: t.ask.questions,
      source: "event",
    });
  }

  /** Remove one pending ask (by requestId) from the kind map + session queue. */
  function clearPending(kind: "permission" | "question", sessionId: string, requestId: string): void {
    pendingByKind(kind).delete(requestId);
    const queue = queueOf(kind, sessionId);
    const idx = queue.indexOf(requestId);
    if (idx !== -1) queue.splice(idx, 1);
  }

  function pendingByKind(kind: "permission" | "question"): Map<string, PendingAsk> {
    return kind === "permission" ? pendingPermission : pendingQuestion;
  }

  function queueOf(kind: "permission" | "question", sessionId: string): string[] {
    const key = `${kind}:${sessionId}`;
    let q = askQueues.get(key);
    if (!q) {
      q = [];
      askQueues.set(key, q);
    }
    return q;
  }

  function pushAskQueue(kind: "permission" | "question", sessionId: string, requestId: string): void {
    queueOf(kind, sessionId).push(requestId);
  }

  /** Oldest still-tracked pending ask for the session (FIFO ring semantics). */
  function shiftAsk(kind: "permission" | "question", sessionId: string): PendingAsk | undefined {
    const queue = queueOf(kind, sessionId);
    while (queue.length > 0) {
      const requestId = queue.shift()!;
      const entry = pendingByKind(kind).get(requestId);
      if (entry) return entry;
    }
    return undefined;
  }

  function hasPendingAsk(sessionId: string): boolean {
    for (const entry of pendingPermission.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    for (const entry of pendingQuestion.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Fire-and-forget pending-ask resync, debounced. */
  let askResyncTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAskResync(): void {
    if (askResyncTimer) return;
    askResyncTimer = setTimeout(() => {
      askResyncTimer = null;
      void syncPendingAsks();
    }, 100);
  }

  async function syncSnapshot(): Promise<void> {
    try {
      // ingest ALL servers (default + project/worktree directories) — a
      // session that only exists in a project dir would otherwise be unknown
      // to getStatus, and ring answers would 404. Archived sessions stay
      // archived (the registry never resurrects them).
      for (const s of await mergedSessionRows()) {
        const known = knownSessions.get(s.id);
        if (known?.time?.archived && !s.time?.archived) continue;
        knownSessions.set(s.id, s);
      }
      Object.assign(activity, await oc.sessionActivity());
    } catch {
      // keep last known state
    }
    schedulePersist();
    await syncPendingAsks();
  }

  /** REST fallback sync of pending permissions/questions (per requestId). */
  async function syncPendingAsks(): Promise<void> {
    let permissions: Array<Record<string, unknown>> = [];
    let questions: Array<Record<string, unknown>> = [];
    try {
      permissions = (await oc.pendingPermissions()) as unknown as Array<Record<string, unknown>>;
    } catch {
      // keep going — questions may still be available
    }
    try {
      questions = (await oc.pendingQuestions()) as unknown as Array<Record<string, unknown>>;
    } catch {
      // keep going — permissions may have been fetched
    }
    const seenPermissions = new Set<string>();
    for (const p of permissions) {
      const sessionId = str(p.sessionID) || str(p.sessionId);
      const requestId = str(p.id);
      if (!sessionId || !requestId) continue;
      seenPermissions.add(requestId);
      if (pendingPermission.has(requestId)) continue;
      pushAskQueue("permission", sessionId, requestId);
      pendingPermission.set(requestId, {
        requestId,
        sessionId,
        directory: knownSessions.get(sessionId)?.directory,
        toolName: str(p.type) || "permission",
        description: str(p.title) || "Permission required",
        questions: [],
        source: "snapshot",
      });
      emit(sessionId, permissionRequestMessage(p as unknown as Parameters<typeof permissionRequestMessage>[0]));
    }
    for (const [requestId, entry] of pendingPermission) {
      if (entry.source === "snapshot" && !seenPermissions.has(requestId)) pendingPermission.delete(requestId);
    }

    const seenQuestions = new Set<string>();
    for (const q of questions) {
      const sessionId = str(q.sessionID) || str(q.sessionId);
      const requestId = str(q.id) || str(q.requestID);
      if (!sessionId || !requestId) continue;
      seenQuestions.add(requestId);
      if (pendingQuestion.has(requestId)) continue;
      const msg = questionMessage(q as unknown as Parameters<typeof questionMessage>[0]);
      if (!msg) continue;
      const qs = Array.isArray((q as { questions?: Array<{ question?: string; header?: string }> }).questions)
        ? ((q as { questions: Array<{ question?: string; header?: string }> }).questions ?? [])
        : [];
      pushAskQueue("question", sessionId, requestId);
      pendingQuestion.set(requestId, {
        requestId,
        sessionId,
        directory: knownSessions.get(sessionId)?.directory,
        toolName: "question",
        description: "Agent has a question",
        questions: qs,
        source: "snapshot",
      });
      emit(sessionId, msg);
    }
    for (const [requestId, entry] of pendingQuestion) {
      if (entry.source === "snapshot" && !seenQuestions.has(requestId)) pendingQuestion.delete(requestId);
    }
  }

  /** On idle: surface the final assistant answer as a `result` message. */
  async function emitIdleResult(sessionId: string): Promise<void> {
    try {
      const session = knownSessions.get(sessionId);
      const messages = await oc.messages(sessionId, session?.directory);
      const text = lastAssistantText(messages);
      const usage = lastAssistantUsage(messages);
      const startedAt = busySince.get(sessionId);
      emit(sessionId, {
        type: "result",
        success: true,
        text: text || "Turn complete.",
        sessionId,
        costUsd: usage.cost,
        provider: PROVIDER_NAME,
        turns: usage.turns,
        durationMs: startedAt ? Date.now() - startedAt : 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch {
      emit(sessionId, { type: "status", state: "idle", sessionId });
    }
  }

  // ── merged session listing (default server + per-directory) ──
  let projectsCache: { at: number; projects: OcProject[] } | null = null;
  const withPrefix = opts.prefixTitles ?? true;
  let aliasesCache: { at: number; map: Map<string, string> } | null = null;
  const settingsPath = opts.settingsPath ?? `${homedir()}/.config/openchamber/settings.json`;

  async function fetchProjectsCached(): Promise<OcProject[]> {
    const now = Date.now();
    if (projectsCache && now - projectsCache.at < mergeTtlMs) return projectsCache.projects;
    try {
      projectsCache = { at: now, projects: await oc.listProjects() };
      return projectsCache.projects;
    } catch {
      return projectsCache?.projects ?? [];
    }
  }

  /** directory -> project alias, from OpenChamber settings.json projects[].label */
  async function fetchAliases(): Promise<Map<string, string>> {
    const now = Date.now();
    if (aliasesCache && now - aliasesCache.at < mergeTtlMs) return aliasesCache.map;
    const map = new Map<string, string>();
    try {
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
        projects?: Array<{ path?: string; label?: string }>;
      };
      for (const p of raw.projects ?? []) {
        if (typeof p.path === "string" && typeof p.label === "string" && p.label.trim()) {
          map.set(normalizeDir(p.path), p.label.trim());
        }
      }
    } catch {
      // settings file missing/unreadable — fall back to folder names
    }
    aliasesCache = { at: Date.now(), map };
    return map;
  }

  function normalizeDir(p: string): string {
    return p.replace(/\/+$/, "");
  }

  async function listDirectories(): Promise<string[]> {
    const dirs = new Set<string>();
    for (const p of await fetchProjectsCached()) {
      if (p.worktree) dirs.add(p.worktree);
      for (const sb of p.sandboxes ?? []) dirs.add(sb);
    }
    // settings.json projects[] is the authoritative list — /api/project may
    // only expose a subset (the desktop's currently-registered servers)
    for (const dir of (await fetchAliases()).keys()) dirs.add(dir);
    return [...dirs];
  }

  async function mergedSessionRows(): Promise<OcSession[]> {
    const rows = new Map<string, OcSession>();
    const ingest = (list: OcSession[]) => {
      for (const s of list) if (!rows.has(s.id)) rows.set(s.id, s);
    };
    const jobs: Array<Promise<void>> = [oc.listSessions().then(ingest).catch(() => undefined)];
    for (const dir of await listDirectories()) {
      jobs.push(oc.listSessions(dir).then(ingest).catch(() => undefined));
    }
    await Promise.all(jobs);
    return [...rows.values()];
  }

  const provider: EvenProvider & { start: () => void; stop: () => void } = {
    async listSessions(limit, cwd) {
      const all = await mergedSessionRows();
      const visible = visibleRootSessions(all);
      const filtered = cwd ? visible.filter((s) => (s.directory ?? "").startsWith(cwd)) : visible;
      const projects = await fetchProjectsCached();
      const aliases = await fetchAliases();
      const rows = filtered
        .slice(0, limit)
        .map((s) => {
          if (!withPrefix) return toEvenSession(s);
          // sessions living in OpenChamber's default (home) directory are
          // projectless chats, not the home-folder "project"
          const label =
            s.directory === homedir() ? "chat" : projectLabelFor(s.directory, projects, aliases);
          return toEvenSession(s, label);
        });
      // projectless glasses sessions live in knownSessions (invisible in the
      // per-directory listings) — overlay them so the glasses can still see them
      for (const s of knownSessions.values()) {
        if (s.time?.archived || rows.some((r) => r.id === s.id)) continue;
        const ocListed = all.some((x) => x.id === s.id);
        if (ocListed) continue;
        const label = withPrefix
          ? s.directory && s.directory !== homedir()
            ? projectLabelFor(s.directory, projects, aliases)
            : "chat"
          : undefined;
        rows.push(toEvenSession(s, label));
      }
      rows.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
      return rows.slice(0, limit);
    },

    async getSessionStatus(id) {
      if (hasPendingAsk(id)) return "awaiting";
      return activity[id]?.type === "busy" ? "busy" : "idle";
    },

    async getInfo() {
      let model = "OpenCode";
      try {
        const recent = visibleRootSessions(await oc.listSessions())[0];
        if (recent?.model) model = recent.model.id;
      } catch {
        // keep default
      }
      return {
        account: { email: "", organization: opts.hostLabel ?? "OpenChamber", subscriptionType: "" },
        model,
        version: "opencode",
        provider: PROVIDER_NAME,
      };
    },

    async getHistory(id, limit) {
      const session = knownSessions.get(id);
      const messages: OcMessage[] = await oc.messages(id, session?.directory);
      return toHistoryRows(messages, limit);
    },

    async prompt(sessionId, text, cwd) {
      // New session from the Even app (no sessionId): create a projectless
      // chat via OpenChamber, then prompt into it. Replies go directly to the
      // opencode server (requestId-scoped), so no directory is required.
      if (!sessionId) {
        const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
        const created = await oc.createSession(title, cwd || opts.newSessionDir || undefined);
        sessionId = created.id;
        knownSessions.set(created.id, created);
        schedulePersist();
      }
      const session = knownSessions.get(sessionId);
      const directory = session?.directory ?? cwd;
      emit(sessionId, { type: "user_prompt", text });
      await oc.promptAsync(
        sessionId,
        text,
        directory,
        session?.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined,
        session?.agent,
      );
      busySessions.add(sessionId);
      if (!busySince.has(sessionId)) busySince.set(sessionId, Date.now());
      startStatsTimer();
      emit(sessionId, { type: "status", state: "busy", sessionId });
      return { sessionId, provider: PROVIDER_NAME };
    },

    respondPermission(id, decision) {
      // FIFO: the Even app replies to the permission card it is showing.
      const pending = shiftAsk("permission", id);
      if (!pending) return;
      clearPending("permission", id, pending.requestId);
      emit(id, {
        type: "permission_result",
        toolName: pending.toolName,
        summary: pending.description,
        decision:
          decision === "allow" ? "allowed" : decision === "allowAlways" ? "always" : "denied",
      });
      // OpenChamber's local API has no reply route — reply directly on the
      // opencode server; fall back to the OC proxy (older versions).
      oc
        .replyPermissionDirect(pending.requestId, decisionToResponse(decision), pending.directory)
        .catch(() =>
          oc.replyPermission(id, pending.requestId, decisionToResponse(decision), pending.directory),
        )
        .catch((err: Error) => {
          emit(id, { type: "notification", message: `Permission reply failed: ${err.message}` });
        });
    },

    respondQuestion(id, answer) {
      const pending = shiftAsk("question", id);
      if (!pending) return;
      clearPending("question", id, pending.requestId);
      const answers = parseQuestionAnswer(answer, pending.questions);
      const answerMap: Record<string, string> = {};
      pending.questions.forEach((q, i) => {
        answerMap[q.question ?? q.header ?? `q${i}`] = answers[i] ?? "";
      });
      emit(id, { type: "question_answer", answers: answerMap });
      oc
        // opencode wants per-question arrays of selected labels
        .replyQuestionDirect(pending.requestId, answers.map((a) => [a]), pending.directory)
        .catch(() => oc.replyQuestion(id, pending.requestId, answers, pending.directory))
        .catch((err: Error) => {
          emit(id, { type: "notification", message: `Answer failed: ${err.message}` });
        });
    },

    interrupt(id) {
      const session = knownSessions.get(id);
      oc.interrupt(id, session?.directory).catch(() => undefined);
      busySessions.delete(id);
      busySince.delete(id);
      emit(id, { type: "status", state: "idle", sessionId: id });
    },

    getStatus(id) {
      if (knownSessions.has(id)) {
        const state = sessionState(activity, id, hasPendingAsk(id));
        return { state, provider: PROVIDER_NAME };
      }
      // registry-persisted sessions (e.g. projectless, post-restart) stay answerable
      return null;
    },

    start() {
      void loadRegistry().then(() => syncSnapshot());
      upstream = connectUpstream({
        url: eventUrl,
        onEvent: handleUpstreamEvent,
        onConnected: () => {
          // fresh state after (re)connect: sessions, activity, pending asks
          void syncSnapshot();
        },
      });
      syncTimer = setInterval(() => {
        void syncSnapshot();
      }, SYNC_INTERVAL_MS);
      statsTimer = setInterval(emitRunningStats, RUNNING_STATS_INTERVAL_MS);
    },

    stop() {
      upstream?.abort();
      upstream = null;
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
    },
  };

  return Object.assign(provider, {
    /** Force a refresh of known sessions, activity and pending asks. */
    syncNow: () => syncSnapshot(),
  }) as EvenProvider & { start: () => void; stop: () => void; syncNow: () => Promise<void> };
}
