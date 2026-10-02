// OpenCode provider for the even-terminal wire contract, backed by the
// opencode v2 API (served by OpenChamber or an opencode server).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import type { EvenMessage, EvenProvider } from "./types.ts";
import { MessageHub } from "./hub.ts";
import { OpenChamberClient, type OcProject, type OcSession } from "./openchamber.ts";
import { connectUpstream, type UpstreamEvent } from "./sse.ts";
import { DeltaCoalescer } from "./throttle.ts";
import {
  OpencodeEventTranslator,
  decisionToResponse,
  formAnswerFromLabels,
  formAskQuestions,
  formQuestionMessage,
  lastAssistantText,
  lastAssistantUsage,
  parseQuestionAnswer,
  permissionRequestMessage,
  projectLabelFor,
  sessionState,
  toEvenSession,
  toHistoryRows,
  visibleRootSessions,
  type AskQuestion,
} from "./translate.ts";

// The Even app filters its session list to known providers, so we present
// as "claude" on the wire (same trick even-terminal-pi uses).
export const PROVIDER_NAME = "claude";

const CACHE_TTL_MS = 5_000;
const SYNC_INTERVAL_MS = 30_000;
const RUNNING_STATS_INTERVAL_MS = 10_000;
const SESSION_FETCH_LIMIT = 100;
/** directories polled for pending permissions/forms on each snapshot */
const ASK_DIRS_MAX = 12;

export interface OpencodeProviderOptions {
  oc: OpenChamberClient;
  hub: MessageHub;
  /** Upstream v2 event stream URL (GET /api/event). */
  eventUrl: string;
  hostLabel?: string;
  cacheTtlMs?: number;
  /** prefix session titles with their project label (default true) */
  prefixTitles?: boolean;
  /** OpenChamber settings.json path for project aliases (default ~/.config/openchamber/settings.json) */
  settingsPath?: string;
  /** pinned directory for new glasses sessions (default: server default location) */
  newSessionDir?: string;
  /** emit tool cards for read-only tools too (default: quiet summaries only) */
  verboseTools?: boolean;
  /** diagnostics sink (never receives tokens) */
  log?: (line: string) => void;
}

interface PendingAsk {
  requestId: string;
  sessionId: string;
  toolName: string;
  description: string;
  questions: AskQuestion[];
  at: number;
}

type AskKind = "permission" | "question";

export function createOpencodeProvider(
  opts: OpencodeProviderOptions,
): EvenProvider & { start: () => void; stop: () => void; syncNow: () => Promise<void> } {
  const { oc, hub, eventUrl } = opts;
  const cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const log = opts.log ?? (() => undefined);

  // ── tracked state (all bounded) ───────────────────────
  const knownSessions = new Map<string, OcSession>();
  let activity: Record<string, { type: string }> = {};
  const pendingPermission = new Map<string, PendingAsk>();
  const pendingQuestion = new Map<string, PendingAsk>();
  /** `${kind}:${sessionId}` -> FIFO requestIds */
  const askQueues = new Map<string, string[]>();
  const busySessions = new Set<string>();
  /** sessionId -> turn start (for running_stats duration) */
  const busySince = new Map<string, number>();
  /** sessionId -> latest usage from session.usage.updated (for running_stats) */
  const usageCache = new Map<string, { input: number; output: number }>();
  /** sessions whose idle transition already produced a `result` this turn */
  const idleHandled = new Set<string>();
  /** sessionId -> error message of a turn that failed (result reports success: false) */
  const failedTurns = new Map<string, string>();
  let defaultDir: string | undefined;

  const translator = new OpencodeEventTranslator(opts.verboseTools ?? false);
  let upstream: { abort: () => void } | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  const coalescer = new DeltaCoalescer((sessionId, text) => {
    hub.emit(sessionId, { type: "text_delta", text });
  });

  function emit(sessionId: string, msg: EvenMessage): void {
    // keep delta ordering: flush buffered text before any other message
    if (msg.type !== "text_delta") coalescer.flush(sessionId);
    hub.emit(sessionId, msg);
  }

  function emitDelta(sessionId: string, text: string): void {
    coalescer.push(sessionId, text);
  }

  function rec(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  }

  function str(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  function rememberSession(s: OcSession): void {
    knownSessions.delete(s.id); // re-insert keeps the map in recency order
    knownSessions.set(s.id, s);
    while (knownSessions.size > 1000) {
      const first = knownSessions.keys().next().value;
      if (first === undefined) break;
      knownSessions.delete(first);
    }
  }

  // ── busy/idle + running stats ──────────────────────────

  function markBusy(sessionId: string): void {
    idleHandled.delete(sessionId);
    busySessions.add(sessionId);
    activity[sessionId] = { type: "running" };
    if (!busySince.has(sessionId)) busySince.set(sessionId, Date.now());
    startStatsTimer();
  }

  function markIdle(sessionId: string): void {
    busySessions.delete(sessionId);
    delete activity[sessionId];
  }

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

  // ── upstream events ────────────────────────────────────

  /** Session bookkeeping events that don't render on the glasses. */
  function trackSessionEvent(event: UpstreamEvent): void {
    const d = event.data;
    const sessionId = str(d.sessionID);
    switch (event.type) {
      case "session.usage.updated": {
        const tokens = rec(d.tokens);
        usageCache.set(sessionId, {
          input: typeof tokens.input === "number" ? tokens.input : 0,
          output: typeof tokens.output === "number" ? tokens.output : 0,
        });
        if (usageCache.size > 128) {
          const first = usageCache.keys().next().value;
          if (first !== undefined) usageCache.delete(first);
        }
        break;
      }
      case "session.created":
        if (sessionId && !str(d.parentID)) {
          oc.getSession(sessionId)
            .then((s) => {
              rememberSession(s);
              sessionsCache = null;
            })
            .catch(() => undefined);
        }
        break;
      case "session.renamed": {
        const known = knownSessions.get(sessionId);
        if (known) known.title = str(d.title) || known.title;
        sessionsCache = null;
        break;
      }
      case "session.deleted":
        knownSessions.delete(sessionId);
        sessionsCache = null;
        break;
      case "session.step.started": {
        const known = knownSessions.get(sessionId);
        const model = rec(d.model);
        if (known && typeof model.id === "string") {
          known.model = { id: model.id, providerID: str(model.providerID), variant: str(model.variant) || undefined };
        }
        break;
      }
    }
  }

  function handleUpstreamEvent(event: UpstreamEvent): void {
    trackSessionEvent(event);
    for (const translated of translator.translate(event)) {
      const { sessionId, msg } = translated;
      if (translated.reply) {
        // answered elsewhere (OpenChamber UI / auto-accept): clear + hint only
        // if the ask was visible on the glasses
        const pending = pendingByKind(translated.reply.kind).get(translated.reply.requestId);
        clearPending(translated.reply.kind, pending?.sessionId ?? sessionId, translated.reply.requestId);
        if (pending) emit(pending.sessionId, msg);
        continue;
      }
      if (translated.ask) {
        if (pendingByKind(translated.ask.kind).has(translated.ask.requestId)) continue; // already shown
        trackAsk(translated.ask.kind, sessionId, translated.ask.requestId, msg, translated.ask.questions);
        if (msg.type === "user_question") {
          emit(sessionId, {
            type: "notification",
            title: "Agent asks",
            message: msg.questions[0]?.question?.slice(0, 120) || "Agent has a question",
          });
        }
      }
      if (msg.type === "status" && msg.state === "busy") {
        const alreadyBusy = busySessions.has(sessionId);
        markBusy(sessionId);
        if (alreadyBusy) continue; // the prompt already announced this turn
      } else if (msg.type === "status" && msg.state === "idle") {
        markIdle(sessionId);
        if (idleHandled.has(sessionId)) continue;
        idleHandled.add(sessionId);
        coalescer.flush(sessionId); // deltas land before the result
        for (const closed of translator.closeBlock(sessionId)) emit(closed.sessionId, closed.msg);
        const failure = failedTurns.get(sessionId);
        failedTurns.delete(sessionId);
        void emitIdleResult(sessionId, failure); // result message doubles as idle signal
        continue;
      }
      if (msg.type === "error") failedTurns.set(sessionId, msg.message);
      if (msg.type === "text_delta") {
        emitDelta(sessionId, msg.text);
        continue;
      }
      emit(sessionId, msg);
    }
    if (event.type === "permission.asked" || event.type === "form.created") {
      scheduleAskResync(); // catch siblings filtered out of the stream
    }
  }

  // ── pending asks (permissions + forms) ─────────────────

  function pendingByKind(kind: AskKind): Map<string, PendingAsk> {
    return kind === "permission" ? pendingPermission : pendingQuestion;
  }

  function queueOf(kind: AskKind, sessionId: string): string[] {
    const key = `${kind}:${sessionId}`;
    let q = askQueues.get(key);
    if (!q) {
      q = [];
      askQueues.set(key, q);
    }
    return q;
  }

  /** Store the request id so ring replies know where to POST. */
  function trackAsk(kind: AskKind, sessionId: string, requestId: string, msg: EvenMessage, questions: AskQuestion[]): void {
    queueOf(kind, sessionId).push(requestId);
    pendingByKind(kind).set(requestId, {
      requestId,
      sessionId,
      toolName: msg.type === "permission_request" ? msg.toolName : "question",
      description: msg.type === "permission_request" ? msg.description : "Agent has a question",
      questions,
      at: Date.now(),
    });
  }

  function clearPending(kind: AskKind, sessionId: string, requestId: string): void {
    pendingByKind(kind).delete(requestId);
    const queue = queueOf(kind, sessionId);
    const idx = queue.indexOf(requestId);
    if (idx !== -1) queue.splice(idx, 1);
    if (queue.length === 0) askQueues.delete(`${kind}:${sessionId}`);
  }

  /** Oldest still-tracked pending ask for the session (FIFO ring semantics). */
  function shiftAsk(kind: AskKind, sessionId: string): PendingAsk | undefined {
    const queue = queueOf(kind, sessionId);
    while (queue.length > 0) {
      const requestId = queue.shift()!;
      const entry = pendingByKind(kind).get(requestId);
      if (entry) return entry;
    }
    return undefined;
  }

  function hasPendingAsk(sessionId: string): boolean {
    for (const entry of pendingPermission.values()) if (entry.sessionId === sessionId) return true;
    for (const entry of pendingQuestion.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  let askResyncTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAskResync(): void {
    if (askResyncTimer) return;
    askResyncTimer = setTimeout(() => {
      askResyncTimer = null;
      void syncPendingAsks();
    }, 250);
  }

  /** Locations worth polling: running sessions first, then the most recent ones. */
  function askDirectories(): Array<string | undefined> {
    const dirs = new Set<string>();
    for (const id of Object.keys(activity)) {
      const dir = knownSessions.get(id)?.directory;
      if (dir) dirs.add(dir);
    }
    const recent = [...knownSessions.values()].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    for (const s of recent) {
      if (dirs.size >= ASK_DIRS_MAX) break;
      if (s.directory) dirs.add(s.directory);
    }
    return [undefined, ...dirs];
  }

  /** REST snapshot of pending permissions/forms (fallback for missed events). */
  async function syncPendingAsks(): Promise<void> {
    const dirs = askDirectories();
    const results = await Promise.allSettled(
      dirs.map(async (dir) => ({ permissions: await oc.pendingPermissions(dir), forms: await oc.pendingForms(dir) })),
    );
    let complete = true;
    const seen = { permission: new Set<string>(), question: new Set<string>() };
    for (const result of results) {
      if (result.status === "rejected") {
        complete = false;
        continue;
      }
      for (const p of result.value.permissions) {
        if (!p.id || !p.sessionID || seen.permission.has(p.id)) continue;
        seen.permission.add(p.id);
        if (pendingPermission.has(p.id)) continue;
        const msg = permissionRequestMessage(p);
        trackAsk("permission", p.sessionID, p.id, msg, []);
        emit(p.sessionID, msg);
      }
      for (const f of result.value.forms) {
        if (!f.id || !f.sessionID || seen.question.has(f.id)) continue;
        seen.question.add(f.id);
        if (pendingQuestion.has(f.id)) continue;
        const msg = formQuestionMessage(f);
        if (!msg) continue;
        trackAsk("question", f.sessionID, f.id, msg, formAskQuestions(f));
        emit(f.sessionID, msg);
      }
    }
    if (!complete) return;
    // drop asks that disappeared upstream (answered elsewhere, missed event)
    const cutoff = Date.now() - 5_000;
    for (const kind of ["permission", "question"] as const) {
      for (const [requestId, entry] of pendingByKind(kind)) {
        if (entry.at < cutoff && !seen[kind].has(requestId)) clearPending(kind, entry.sessionId, requestId);
      }
    }
  }

  // ── snapshots ──────────────────────────────────────────

  let sessionsCache: { at: number; rows: OcSession[] } | null = null;

  async function fetchSessions(force = false): Promise<OcSession[]> {
    const now = Date.now();
    if (!force && sessionsCache && now - sessionsCache.at < cacheTtlMs) return sessionsCache.rows;
    const rows = await oc.listSessions(SESSION_FETCH_LIMIT);
    for (const s of rows) rememberSession(s);
    sessionsCache = { at: now, rows };
    return rows;
  }

  async function syncSnapshot(): Promise<void> {
    try {
      await fetchSessions(true);
    } catch (err) {
      log(`[sync] session list failed: ${(err as Error).message}`);
    }
    try {
      activity = await oc.activeSessions();
      for (const id of Object.keys(activity)) {
        if (!busySessions.has(id)) markBusy(id);
      }
      for (const id of [...busySessions]) {
        if (!activity[id]) markIdle(id);
      }
    } catch (err) {
      log(`[sync] activity failed: ${(err as Error).message}`);
    }
    if (defaultDir === undefined) defaultDir = await oc.defaultDirectory().catch(() => undefined);
    translator.prune();
    await syncPendingAsks().catch((err: Error) => log(`[sync] pending asks failed: ${err.message}`));
  }

  /** On idle: surface the final assistant answer as a `result` message. */
  async function emitIdleResult(sessionId: string, failure?: string): Promise<void> {
    const startedAt = busySince.get(sessionId);
    busySince.delete(sessionId);
    try {
      const messages = await oc.messages(sessionId, 60);
      const text = lastAssistantText(messages);
      const usage = lastAssistantUsage(messages);
      emit(sessionId, {
        type: "result",
        success: failure === undefined,
        text: text || failure || "Turn complete.",
        sessionId,
        costUsd: usage.cost,
        provider: PROVIDER_NAME,
        turns: usage.turns,
        durationMs: startedAt ? Date.now() - startedAt : 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (err) {
      log(`[result] ${sessionId}: ${(err as Error).message}`);
      emit(sessionId, { type: "status", state: "idle", sessionId });
    }
  }

  // ── labels ─────────────────────────────────────────────

  const withPrefix = opts.prefixTitles ?? true;
  const settingsPath = opts.settingsPath ?? `${homedir()}/.config/openchamber/settings.json`;
  let projectsCache: { at: number; projects: OcProject[] } | null = null;
  let aliasesCache: { at: number; map: Map<string, string> } | null = null;

  async function fetchProjects(): Promise<OcProject[]> {
    const now = Date.now();
    if (projectsCache && now - projectsCache.at < cacheTtlMs) return projectsCache.projects;
    try {
      const projects = (await oc.listProjects()).filter((p) => p.worktree && p.worktree !== defaultDir);
      projectsCache = { at: now, projects };
      return projects;
    } catch {
      return projectsCache?.projects ?? [];
    }
  }

  /** directory -> project alias, from OpenChamber settings.json projects[].label (local only). */
  async function fetchAliases(): Promise<Map<string, string>> {
    const now = Date.now();
    if (aliasesCache && now - aliasesCache.at < cacheTtlMs) return aliasesCache.map;
    const map = new Map<string, string>();
    try {
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
        projects?: Array<{ path?: string; label?: string }>;
      };
      for (const p of raw.projects ?? []) {
        if (typeof p.path === "string" && typeof p.label === "string" && p.label.trim()) {
          map.set(p.path.replace(/\/+$/, ""), p.label.trim());
        }
      }
    } catch {
      // settings file missing (e.g. remote OpenChamber) — fall back to folder names
    }
    aliasesCache = { at: now, map };
    return map;
  }

  function labelFor(s: OcSession, projects: OcProject[], aliases: Map<string, string>): string {
    if (!s.directory || s.directory === defaultDir) return "chat";
    return projectLabelFor(s.directory, projects, aliases);
  }

  // ── provider surface ───────────────────────────────────

  const provider: EvenProvider & { start: () => void; stop: () => void } = {
    async listSessions(limit, cwd) {
      const all = await fetchSessions();
      const visible = visibleRootSessions(all);
      const root = cwd?.replace(/\/+$/, "");
      const filtered = root
        ? visible.filter((s) => s.directory === root || (s.directory ?? "").startsWith(`${root}/`))
        : visible;
      const [projects, aliases] = withPrefix ? await Promise.all([fetchProjects(), fetchAliases()]) : [[], new Map()];
      return filtered
        .slice(0, limit)
        .map((s) => (withPrefix ? toEvenSession(s, labelFor(s, projects, aliases)) : toEvenSession(s)));
    },

    async getSessionStatus(id) {
      return sessionState(activity, id, hasPendingAsk(id));
    },

    async getInfo() {
      let model = "OpenCode";
      try {
        const recent = visibleRootSessions(await fetchSessions())[0];
        if (recent?.model) model = recent.model.id;
      } catch {
        // keep default
      }
      return {
        account: { email: "", organization: opts.hostLabel || "OpenChamber", subscriptionType: "" },
        model,
        version: "opencode",
        provider: PROVIDER_NAME,
      };
    },

    async getHistory(id, limit) {
      return toHistoryRows(await oc.messages(id, 100), limit);
    },

    async prompt(sessionId, text, cwd) {
      // New session from the Even app (no sessionId): create one at the
      // pinned/requested directory, or the server's default location.
      if (!sessionId) {
        const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
        const created = await oc.createSession(title, cwd || opts.newSessionDir || undefined);
        if (!created.id) throw new Error("OpenCode did not return a session id");
        sessionId = created.id;
        rememberSession(created);
        sessionsCache = null;
      }
      emit(sessionId, { type: "user_prompt", text });
      await oc.prompt(sessionId, text);
      markBusy(sessionId);
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
        decision: decision === "allow" ? "allowed" : decision === "allowAlways" ? "always" : "denied",
      });
      oc.replyPermission(pending.sessionId, pending.requestId, decisionToResponse(decision)).catch((err: Error) => {
        log(`[permission] ${pending.requestId}: ${err.message}`);
        emit(id, { type: "notification", message: `Permission reply failed: ${err.message}` });
      });
    },

    respondQuestion(id, answer) {
      const pending = shiftAsk("question", id);
      if (!pending) return;
      clearPending("question", id, pending.requestId);
      const labels = parseQuestionAnswer(answer, pending.questions);
      const answerMap: Record<string, string> = {};
      pending.questions.forEach((q, i) => {
        answerMap[q.question] = labels[i] ?? "";
      });
      emit(id, { type: "question_answer", answers: answerMap });
      const formAnswer = formAnswerFromLabels(pending.questions, labels);
      const skipped = answer.trim().toLowerCase() === "skip" || Object.keys(formAnswer).length === 0;
      const call = skipped
        ? oc.cancelForm(pending.sessionId, pending.requestId)
        : oc.replyForm(pending.sessionId, pending.requestId, formAnswer);
      call.catch((err: Error) => {
        log(`[question] ${pending.requestId}: ${err.message}`);
        emit(id, { type: "notification", message: `Answer failed: ${err.message}` });
      });
    },

    interrupt(id) {
      oc.interrupt(id).catch((err: Error) => log(`[interrupt] ${id}: ${err.message}`));
      markIdle(id);
      busySince.delete(id);
      idleHandled.add(id); // the upstream interrupted event must not add a result card
      coalescer.flush(id);
      for (const closed of translator.closeBlock(id)) emit(closed.sessionId, closed.msg);
      emit(id, { type: "status", state: "idle", sessionId: id });
    },

    getStatus(id) {
      if (!knownSessions.has(id) && !activity[id] && !hasPendingAsk(id)) return null;
      return { state: sessionState(activity, id, hasPendingAsk(id)), provider: PROVIDER_NAME };
    },

    start() {
      void syncSnapshot();
      upstream = connectUpstream({
        url: eventUrl,
        headers: oc.authHeaders(),
        onEvent: handleUpstreamEvent,
        onConnected: () => {
          log(`[upstream] connected ${eventUrl}`);
          // fresh state after (re)connect: sessions, activity, pending asks
          void syncSnapshot();
        },
        onDisconnected: (reason) => log(`[upstream] disconnected${reason ? `: ${reason}` : ""}`),
      });
      syncTimer = setInterval(() => {
        void syncSnapshot();
      }, SYNC_INTERVAL_MS);
    },

    stop() {
      upstream?.abort();
      upstream = null;
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      if (askResyncTimer) clearTimeout(askResyncTimer);
      askResyncTimer = null;
    },
  };

  return Object.assign(provider, {
    /** Force a refresh of known sessions, activity and pending asks. */
    syncNow: () => syncSnapshot(),
  }) as EvenProvider & { start: () => void; stop: () => void; syncNow: () => Promise<void> };
}
