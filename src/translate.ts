// Pure translation layer: opencode bus events + REST shapes -> even-terminal
// messages. No I/O — fully unit-testable.

import type { EvenMessage, EvenSession, HistoryItem } from "./types.ts";
import type {
  OcMessage,
  OcPermission,
  OcQuestion,
  OcSession,
  OcSessionActivity,
} from "./openchamber.ts";
import type { UpstreamEvent } from "./sse.ts";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** One translated upstream event, with optional ask/reply bookkeeping. */
export interface Translated {
  sessionId: string;
  msg: EvenMessage;
  ask?: { kind: "permission" | "question"; requestId: string; questions: Array<{ question?: string; header?: string }> };
  reply?: { kind: "permission" | "question"; requestId: string };
}

function trimMap(map: Map<string, string>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

/** Last path segment, like upstream's summary-format fileName(). */
function fileName(path: string): string {
  return basename(path);
}

/** Longest label length that fits the glasses list comfortably. */
export const MAX_LABEL_LEN = 14;

/** Abbreviate a long label: keep leading words that fit, end with an ellipsis. */
export function abbrevLabel(label: string, max = MAX_LABEL_LEN): string {
  if (label.length <= max) return label;
  const words = label.split(/[-_]+/); // keep dots (versions) together
  let kept = "";
  for (const word of words) {
    const candidate = kept ? `${kept}-${word}` : word;
    if (candidate.length + 1 > max) break; // ellipsis takes one char
    kept = candidate;
  }
  if (kept) return `${kept}…`;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

/** Tool parts emit tool_start once and tool_end on completion. In the default
 *  quiet mode, read-only tools are hidden entirely and action tools get
 *  compact single-line summaries (mirroring upstream's glasses style). */
const QUIET_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "codesearch",
  "todo",
  "todos",
  "todoread",
  "todowrite",
  "toolsearch",
  "question",
  "ask",
  "askuserquestion",
]);

function toolSummary(name: string, state: Record<string, unknown>): string {
  const input = rec(state.input);
  const title = str(state.title);
  switch (name.toLowerCase()) {
    case "bash": {
      const cmd = str(input.command).split("\n")[0] ?? "";
      return capText(cmd || title, 50) || "command";
    }
    case "edit":
    case "write":
    case "patch": {
      const file = fileName(str(input.filePath) || str(input.file_path) || str(state.title));
      if (name.toLowerCase() === "edit" || name.toLowerCase() === "patch") {
        const added = str(input.newString || input.new_string).split("\n").length;
        const removed = str(input.oldString || input.old_string).split("\n").length;
        const delta = (input.newString ? added : 0) - (input.oldString ? removed : 0);
        return file + (delta > 0 ? ` +${delta}` : delta < 0 ? ` ${delta}` : "");
      }
      return file;
    }
    case "webfetch": {
      const url = str(input.url || input.url_);
      return url.replace(/^https?:\/\//, "").slice(0, 50);
    }
    case "task":
      return capText(str(input.description) || title, 50) || "agent";
    default: {
      const title2 = title || str(input.description) || name;
      return capText(title2, 50);
    }
  }
}

/** Keep detail payloads tiny: bash keeps its command, everything else drops input. */
function toolDetailInput(name: string, state: Record<string, unknown>): string | undefined {
  const input = rec(state.input);
  if (name.toLowerCase() === "bash") return capText(str(input.command), 120) || undefined;
  return undefined;
}

// ── Event stream translation ─────────────────────────────

/** TodoWrite tool input -> glasses progress bar (pure extraction). */
export function taskProgressFromTodos(state: Record<string, unknown>): EvenMessage | null {
  const input = rec(state.input);
  const todos = Array.isArray(input.todos) ? input.todos : [];
  if (todos.length === 0) return null;
  let completed = 0;
  let current = "";
  for (const todo of todos) {
    const t = rec(todo);
    const status = str(t.status);
    if (status === "completed") completed++;
    if (!current && status === "in_progress") current = str(t.content);
  }
  if (!current) current = "All tasks done";
  return { type: "task_progress", completed, total: todos.length, current };
}

// ── Event stream translation ─────────────────────────────

/**
 * Tracks per-part text so `message.part.updated`/`message.part.delta` events
 * can be turned into append-only deltas; reasoning parts become thinking
 * states; user messages never stream. Bounded memory.
 */
export class OpencodeEventTranslator {
  /** `${sessionId}:${messageId}:${partId}` -> last emitted text */
  private lastText = new Map<string, string>();
  /** `${sessionId}:${callID}` -> tool name (for tool_end pairing) */
  private toolNames = new Map<string, string>();
  /** `${sessionId}:${messageId}:${partId}` -> part type (text vs reasoning vs tool) */
  private partTypes = new Map<string, string>();
  /** messageID -> role, so the user's own messages don't stream as text */
  private messageRoles = new Map<string, string>();
  /** per-session open render block: "thinking" | "text" */
  private blockState = new Map<string, "thinking" | "text">();

  constructor(fallbackSessionId = "", verboseTools = false) {
    this.fallbackSessionId = fallbackSessionId;
    this.verboseTools = verboseTools;
  }
  private readonly fallbackSessionId: string;
  /** emit tool cards for read-only tools too (default: quiet) */
  private readonly verboseTools: boolean;

  /** Translate one upstream event into 0..n even-terminal messages. */
  translate(event: UpstreamEvent): Array<Translated> {
    const props = event.properties ?? {};
    switch (event.type) {
      case "message.part.updated":
        return this.partUpdated(props);
      case "message.part.delta":
        return this.partDelta(props);
      case "message.updated": {
        const info = rec(props.info);
        const mid = str(info.id);
        const role = str(info.role);
        if (mid && role) this.messageRoles.set(mid, role);
        return [];
      }
      case "session.status": {
        const sessionId = str(props.sessionID) || this.fallbackSessionId;
        const status = rec(props.status);
        const state = str(status.type);
        if (state === "busy") {
          return [{ sessionId, msg: { type: "status", state: "busy", sessionId } }];
        }
        if (state === "idle") {
          return [{ sessionId, msg: { type: "status", state: "idle", sessionId } }];
        }
        if (state === "retry") {
          const attempt = status.attempt;
          const attemptStr =
            typeof attempt === "number" || typeof attempt === "string" ? String(attempt) : "";
          return [
            {
              sessionId,
              msg: {
                type: "notification",
                title: "Retrying",
                message: attemptStr ? `Retrying (attempt ${attemptStr})…` : "Retrying…",
              },
            },
          ];
        }
        return [];
      }
      case "session.error": {
        const sessionId = str(props.sessionID) || this.fallbackSessionId;
        if (!sessionId) return [];
        const err = rec(props.error);
        const message = str(err.message) || str(props.error) || "Agent error";
        return [{ sessionId, msg: { type: "error", message: capText(message, 200) } }];
      }
      case "session.idle": {
        const sessionId = str(props.sessionID) || this.fallbackSessionId;
        return [{ sessionId, msg: { type: "status", state: "idle", sessionId } }];
      }
      case "question.asked":
        return this.questionAsked(props);
      case "permission.asked":
        return this.permissionAsked(props);
      case "question.replied":
      case "question.rejected":
        return this.replied(props, "question");
      case "permission.replied":
        return this.replied(props, "permission");
      default:
        return [];
    }
  }

  /** Incremental text streaming (current opencode). */
  private partDelta(props: Record<string, unknown>): Array<Translated> {
    const sessionId = str(props.sessionID) || this.fallbackSessionId;
    if (!sessionId) return [];
    const messageId = str(props.messageID);
    const partId = str(props.partID);
    const partType = this.partTypes.get(`${sessionId}:${messageId}:${partId}`);

    // model chain-of-thought: suppress the raw text, show the thinking indicator
    if (partType === "reasoning") return this.thinkTransition(sessionId, true);
    if (partType && partType !== "text") return []; // step markers etc. carry no renderable text

    if (this.messageRoles.get(messageId) === "user") return [];
    const field = str(props.field) || "text";
    if (field !== "text") return []; // tool-state deltas arrive as full part updates
    const delta = str(props.delta);
    if (!delta) return [];

    const out: Array<{ sessionId: string; msg: EvenMessage }> = [];
    out.push(...this.textTransition(sessionId));
    const key = `${sessionId}:${messageId}:${partId}`;
    const next = (this.lastText.get(key) ?? "") + delta;
    this.lastText.set(key, next);
    out.push({ sessionId, msg: { type: "text_delta", text: delta } });
    return out;
  }

  /** Entering/leaving a thinking block. */
  private thinkTransition(
    sessionId: string,
    entering: boolean,
  ): Array<{ sessionId: string; msg: EvenMessage }> {
    const current = this.blockState.get(sessionId);
    const out: Array<{ sessionId: string; msg: EvenMessage }> = [];
    if (entering) {
      if (current === "thinking") return [];
      if (current === "text") {
        out.push({ sessionId, msg: { type: "status", state: "text_end", sessionId } });
      }
      this.blockState.set(sessionId, "thinking");
      out.push({ sessionId, msg: { type: "status", state: "think_start", sessionId } });
      return out;
    }
    if (this.blockState.get(sessionId) === "thinking") {
      this.blockState.delete(sessionId);
      return [{ sessionId, msg: { type: "status", state: "think_end", sessionId } }];
    }
    return [];
  }

  /** Entering (or continuing) a text block. */
  private textTransition(
    sessionId: string,
    delta?: string,
  ): Array<{ sessionId: string; msg: EvenMessage }> {
    const out: Array<{ sessionId: string; msg: EvenMessage }> = [];
    if (this.blockState.get(sessionId) === "thinking") {
      out.push({ sessionId, msg: { type: "status", state: "think_end", sessionId } });
    }
    if (this.blockState.get(sessionId) !== "text") {
      this.blockState.set(sessionId, "text");
      out.push({ sessionId, msg: { type: "status", state: "text_start", sessionId } });
    }
    if (delta) out.push({ sessionId, msg: { type: "text_delta", text: delta } });
    return out;
  }

  /** Close any open block (on tool start, step finish, or idle). */
  closeBlock(sessionId: string): Array<{ sessionId: string; msg: EvenMessage }> {
    const current = this.blockState.get(sessionId);
    if (!current) return [];
    this.blockState.delete(sessionId);
    return [
      { sessionId, msg: { type: "status", state: current === "thinking" ? "think_end" : "text_end", sessionId } },
    ];
  }

  private partUpdated(props: Record<string, unknown>): Array<Translated> {
    const part = rec(props.part);
    const sessionId = str(part.sessionID) || str(props.sessionID) || this.fallbackSessionId;
    if (!sessionId) return [];
    const messageId = str(part.messageID) || str(props.messageID);
    const partId = str(part.id) || messageId;
    const type = str(part.type);

    // remember the part's type so part.delta events (which only carry ids)
    // can tell assistant text from model reasoning
    this.partTypes.set(`${sessionId}:${messageId}:${partId}`, type);

    if (type === "text") {
      // the user's own message parts stream like text parts; the bridge
      // already echoes prompts via user_prompt — never re-render them
      if (this.messageRoles.get(messageId) === "user") return [];
      const text = str(part.text);
      const key = `${sessionId}:${messageId}:${partId}`;
      const prev = this.lastText.get(key) ?? "";
      if (text === prev) return [];
      const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
      this.lastText.set(key, text);
      return this.textTransition(sessionId, delta);
    }

    if (type === "reasoning") {
      // model chain-of-thought: never stream as text; drive the "thinking…"
      // indicator instead (mirrors upstream's content-block states)
      return this.thinkTransition(sessionId, true);
    }

    if (type === "tool") {
      this.partTypes.set(`${sessionId}:${messageId}:${partId}`, type);
      const state = rec(part.state);
      const callId = str(part.callID) || `${messageId}:${partId}`;
      const name = str(part.tool) || "tool";
      const status = str(state.status);
      const tKey = `${sessionId}:${callId}`;
      // a tool call always ends any open text/think block on the glasses
      const blockClose = this.closeBlock(sessionId);
      // Verbose mode emits every tool; quiet mode hides the read-only herd.
      if (!this.verboseTools && QUIET_TOOLS.has(name.toLowerCase())) {
        // keep bookkeeping so completion never emits a late start/end pair
        if (status === "pending" || status === "running") this.toolNames.set(tKey, name);
        else this.toolNames.delete(tKey);
        // todos still drive the progress bar even with the card hidden
        if (name.toLowerCase() === "todowrite" && (status === "completed" || status === "error")) {
          const progress = taskProgressFromTodos(state);
          return [...blockClose, ...(progress ? [{ sessionId, msg: progress }] : [])];
        }
        return blockClose;
      }
      if (status === "pending" || status === "running") {
        if (!this.toolNames.has(tKey)) {
          this.toolNames.set(tKey, name);
          return [...blockClose, { sessionId, msg: { type: "tool_start", name, toolId: callId } }];
        }
        return [];
      }
      if (status === "completed" || status === "error") {
        const known = this.toolNames.has(tKey);
        this.toolNames.delete(tKey);
        const start = known ? [] : [{ sessionId, msg: { type: "tool_start", name, toolId: callId } as EvenMessage }];
        const progress =
          name.toLowerCase() === "todowrite" ? taskProgressFromTodos(state) : null;
        const end: EvenMessage = {
          type: "tool_end",
          name,
          toolId: callId,
          summary: toolSummary(name, state),
          // quiet mode keeps cards to a single line; detail is verbose-only
          ...(this.verboseTools
            ? { detail: { input: toolDetailInput(name, state), output: capText(str(state.output), 200) } }
            : {}),
        };
        const out: Array<{ sessionId: string; msg: EvenMessage }> = [
          ...start,
          { sessionId, msg: end },
        ];
        if (progress) out.push({ sessionId, msg: progress });
        return out;
      }
    }
    return [];
  }


  /** Bound memory: drop the oldest tracked entries when over budget. */
  prune(maxParts = 512, maxTools = 128): void {
    trimMap(this.lastText, maxParts);
    trimMap(this.toolNames, maxTools);
    trimMap(this.partTypes, maxParts);
    trimMap(this.blockState, 64);
  }

  private questionAsked(props: Record<string, unknown>): Array<Translated> {
    const sessionId = str(props.sessionID) || this.fallbackSessionId;
    if (!sessionId) return [];
    const questions = Array.isArray(props.questions) ? props.questions : [];
    if (questions.length === 0) return [];
    const requestId = str(props.id) || str(props.requestID);
    return [
      {
        sessionId,
        msg: {
          type: "user_question",
          toolUseId: requestId,
          questions: questions.map((q) => {
            const entry = rec(q);
            return {
              question: str(entry.question),
              header: str(entry.header),
              options: (Array.isArray(entry.options) ? entry.options : []).map((o) => {
                const opt = rec(o);
                return { label: str(opt.label), description: str(opt.description), preview: "" };
              }),
            };
          }),
        },
        ask: {
          kind: "question",
          requestId,
          questions: questions.map((q) => {
            const entry = rec(q);
            return { question: str(entry.question), header: str(entry.header) };
          }),
        },
      },
    ];
  }

  private permissionAsked(props: Record<string, unknown>): Array<Translated> {
    const sessionId = str(props.sessionID) || this.fallbackSessionId;
    if (!sessionId) return [];
    const permission = rec(props.permission);
    const p = Object.keys(permission).length > 0 ? permission : props;
    const requestId = str(p.id) || str(props.id);
    if (!requestId) return [];
    return [
      {
        sessionId,
        msg: permissionRequestMessage(p as unknown as OcPermission),
        ask: { kind: "permission", requestId, questions: [] },
      },
    ];
  }

  /** A pending ask was answered elsewhere (OpenChamber UI / auto-accept). */
  private replied(
    props: Record<string, unknown>,
    kind: "permission" | "question",
  ): Array<Translated> {
    const sessionId = str(props.sessionID) || this.fallbackSessionId;
    return [
      {
        sessionId,
        msg: {
          type: "notification",
          message:
            kind === "question"
              ? "Question timed out or answered elsewhere"
              : "Permission handled outside the glasses",
        },
        reply: { kind, requestId: str(props.requestID) || str(props.id) },
      },
    ];
  }
}

// ── REST shape mapping ───────────────────────────────────

/** Root, non-archived, titled sessions sorted by most recent update. */
export function visibleRootSessions(list: OcSession[]): OcSession[] {
  return list
    .filter((s) => !s.time?.archived && !s.parentID)
    .filter((s) => !IGNORED_TITLE.test(s.title ?? ""))
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
}

const IGNORED_TITLE = /^(New session|Untitled|session) - /;

export function toEvenSession(s: OcSession, label?: string): EvenSession {
  const base = (s.title ?? s.id).trim();
  const title = label ? `${label} · ${base}` : base;
  return {
    id: s.id,
    title: title.slice(0, 64),
    timestamp: new Date(s.time?.updated ?? s.time?.created ?? Date.now()).toISOString(),
    cwd: s.directory ?? "",
    provider: "claude",
    status: null,
  };
}

export function sessionState(
  activity: Record<string, { type: string }>,
  sessionId: string,
  hasPendingAsk: boolean,
): string {
  if (hasPendingAsk) return "awaiting";
  return activity[sessionId]?.type === "busy" ? "busy" : "idle";
}

export interface HistoryRow {
  role: string;
  text: string;
}

/** Flatten messages into terminal-style history rows, newest last. */
export function toHistoryRows(messages: OcMessage[], limit: number, maxChars = 4000): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const m of messages) {
    const isUser = m.info.role === "user";
    for (const part of m.parts) {
      if (part.type === "text") {
        const text = (part.text ?? "").trim();
        if (!text) continue;
        rows.push({ role: m.info.role, text: (isUser ? "you: " : "") + text.trim() });
      } else if (part.type === "tool") {
        const state = rec(part.state);
        rows.push({ role: "tool", text: "> " + (str(state.title) || str(part.tool) || "working") });
      }
    }
  }
  const out: HistoryRow[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    used += rows[i]!.text.length + 1;
    if (used > maxChars) break;
    out.unshift(rows[i]!);
  }
  return out;
}

// ── Permissions & questions ──────────────────────────────

export function buildPermissionOptions(
  alwaysLabel = "Yes, and always allow",
): Array<{ text: string; key: string }> {
  return [
    { text: "Yes", key: "allow" },
    { text: alwaysLabel, key: "allowAlways" },
    { text: "No", key: "deny" },
  ];
}

/** Pending permission -> permission_request message for the glasses. */
export function permissionRequestMessage(p: OcPermission): EvenMessage {
  const meta = rec(p.metadata);
  const rawPattern = p.pattern ?? meta.pattern ?? p.patterns ?? meta.patterns;
  const patterns = Array.isArray(rawPattern) ? rawPattern.map((x) => String(x)) : rawPattern ? [String(rawPattern)] : [];
  const toolName = str(p.type) || "permission";
  const title = str(p.title) || toolName;
  return {
    type: "permission_request",
    toolName,
    description: title,
    detail: patterns.join(", ").slice(0, 200),
    toolUseId: str(p.id),
    options: buildPermissionOptions(),
    suggestions: null,
  };
}

/** Map an app decision ("allow" | "allowAlways" | "deny") to opencode's response verb. */
export function decisionToResponse(decision: string): "once" | "always" | "reject" {
  if (decision === "allowAlways") return "always";
  if (decision === "allow") return "once";
  return "reject";
}

/** Pending question -> user_question message for the glasses. */
export function questionMessage(q: OcQuestion): EvenMessage | null {
  const questions = Array.isArray(q.questions) ? q.questions : [];
  if (questions.length === 0) return null;
  return {
    type: "user_question",
    questions: questions.map((entry) => ({
      question: str(entry.question),
      header: str(entry.header),
      options: (entry.options ?? []).map((o) => ({
        label: str(o.label),
        description: str(o.description),
        preview: "",
      })),
    })),
    toolUseId: str(q.id),
  };
}

/**
 * The app replies with either plain text (first question) or a JSON map of
 * {questionOrHeader: label}. Normalize to ordered answer strings.
 */
export function parseQuestionAnswer(
  answer: string,
  questions: Array<{ question?: string; header?: string }>,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.trim());
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const map = parsed as Record<string, unknown>;
    return questions.map((q) => {
      const key = q.question ?? q.header ?? "";
      const value = map[key];
      return typeof value === "string" ? value : "";
    });
  }
  const plain = answer.trim();
  if (Array.isArray(parsed)) return parsed.map((a) => String(a));
  return questions.map(() => plain);
}

/** Last assistant text of a message list (for the result message on idle). */
export function lastAssistantText(messages: OcMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.info.role !== "assistant") continue;
    const text = m.parts
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text!.trim())
      .join("\n");
    if (text) return text;
  }
  return "";
}

/** Turn stats from the tail of a message list (assistant messages only). */
export function lastAssistantUsage(messages: OcMessage[]): {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turns: number;
} {
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.info.role === "user") break; // turn boundary
    if (m.info.role !== "assistant") continue;
    turns++;
    const tokens = (m.info as { tokens?: { input?: number; output?: number } }).tokens;
    const cost = (m.info as { cost?: number }).cost ?? 0;
    return {
      inputTokens: tokens?.input ?? 0,
      outputTokens: tokens?.output ?? 0,
      cost,
      turns,
    };
  }
  return { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 };
}

export interface OcProject {
  id: string;
  worktree?: string;
  sandboxes?: string[];
  name?: string;
}

/**
 * Short project label for a session directory.
 * Sandbox/worktree dirs inherit their parent project's label; otherwise the
 * project whose worktree contains the directory. An explicit OpenChamber
 * alias (settings.json projects[].label) wins over the folder basename.
 */
export function projectLabelFor(
  directory: string | undefined,
  projects: OcProject[],
  aliases?: Map<string, string>,
): string {
  if (!directory || directory === "/") return "";
  const norm = (p: string) => p.replace(/\/+$/, "");
  const dir = norm(directory);
  const byWorktree = new Map<string, OcProject>();
  const sandboxParent = new Map<string, string>();
  for (const p of projects) {
    if (!p.worktree || p.worktree === "/") continue;
    byWorktree.set(norm(p.worktree), p);
    for (const sb of p.sandboxes ?? []) sandboxParent.set(norm(sb), p.worktree ?? "");
  }
  const sandboxDir = sandboxParent.has(dir)
    ? dir
    : [...sandboxParent.keys()].find((sb) => dir.startsWith(sb + "/"));
  const parent = sandboxDir !== undefined ? sandboxParent.get(sandboxDir) : undefined;
  const worktree = parent ?? [...byWorktree.keys()].find((wt) => dir === wt || dir.startsWith(wt + "/"));
  if (!worktree) {
    // OpenChamber's internal chat dirs have no project — label them "chat"
    // instead of showing the raw session UUID.
    if (directory.includes("/.config/openchamber/chats/") && basename(directory).startsWith("session-")) {
      return "chat";
    }
    return abbrevLabel(aliases?.get(dir) ?? basename(directory));
  }
  return abbrevLabel(aliases?.get(worktree) ?? basename(worktree));
}
