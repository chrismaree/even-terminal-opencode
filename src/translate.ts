// Pure translation layer: opencode v2 bus events + REST shapes -> even-terminal
// messages. No I/O — fully unit-testable.

import type { EvenMessage, EvenSession, HistoryItem } from "./types.ts";
import type {
  OcForm,
  OcFormField,
  OcMessage,
  OcPermission,
  OcPermissionReply,
  OcProject,
  OcSession,
} from "./openchamber.ts";
import type { UpstreamEvent } from "./sse.ts";

export type { OcProject } from "./openchamber.ts";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Question bookkeeping kept per pending ask so ring answers map back to form fields. */
export interface AskQuestion {
  question: string;
  header?: string;
  field?: OcFormField;
}

/** One translated upstream event, with optional ask/reply bookkeeping. */
export interface Translated {
  sessionId: string;
  msg: EvenMessage;
  ask?: { kind: "permission" | "question"; requestId: string; questions: AskQuestion[] };
  reply?: { kind: "permission" | "question"; requestId: string };
}

function trimMap<K, V>(map: Map<K, V>, max: number): void {
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

/** In quiet mode, read-only tools are hidden entirely and action tools get
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
  "skill",
  "question",
  "ask",
  "askuserquestion",
]);

const TODO_TOOLS = new Set(["todowrite", "todo"]);

function filePathOf(input: Record<string, unknown>): string {
  return str(input.path) || str(input.filePath) || str(input.file_path);
}

/** One-line tool summary from the tool name + its input (v2 tool names). */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name.toLowerCase()) {
    case "shell":
    case "bash": {
      const cmd = str(input.command).split("\n")[0] ?? "";
      return capText(cmd, 50) || "command";
    }
    case "edit":
    case "patch": {
      const file = basename(filePathOf(input));
      const added = str(input.newString || input.new_string).split("\n").length;
      const removed = str(input.oldString || input.old_string).split("\n").length;
      const delta = (input.newString ? added : 0) - (input.oldString ? removed : 0);
      return (file || name) + (delta > 0 ? ` +${delta}` : delta < 0 ? ` ${delta}` : "");
    }
    case "write":
      return basename(filePathOf(input)) || "write";
    case "read":
      return basename(filePathOf(input)) || "read";
    case "grep":
    case "glob":
      return capText(str(input.pattern), 50) || name;
    case "webfetch":
      return str(input.url).replace(/^https?:\/\//, "").slice(0, 50) || "webfetch";
    case "websearch":
      return capText(str(input.query), 50) || "websearch";
    case "task":
    case "subagent":
      return capText(str(input.description), 50) || "agent";
    case "skill":
      return str(input.id) || "skill";
    default:
      return capText(str(input.description) || str(input.action) || name, 50);
  }
}

/** Keep detail payloads tiny: shell keeps its command, everything else drops input. */
function toolDetailInput(name: string, input: Record<string, unknown>): string | undefined {
  const n = name.toLowerCase();
  if (n === "shell" || n === "bash") return capText(str(input.command), 120) || undefined;
  return undefined;
}

function toolOutputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => str(rec(c).text))
    .filter(Boolean)
    .join("\n");
}

/** Todo tool input -> glasses progress bar (pure extraction). */
export function taskProgressFromTodos(input: Record<string, unknown>): EvenMessage | null {
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

interface ToolTrack {
  name: string;
  input: Record<string, unknown>;
  started: boolean;
}

// ── Event stream translation ─────────────────────────────

/**
 * Translates opencode v2 session events into glasses messages. Text arrives as
 * `session.text.delta`; reasoning drives the thinking indicator; tools are
 * paired by tool id. Bounded memory.
 */
export class OpencodeEventTranslator {
  /** `${sessionId}:${assistantMessageID}:${ordinal}` -> text streamed so far */
  private streamed = new Map<string, string>();
  /** `${sessionId}:${toolId}` -> tool name/input/start-emitted */
  private tools = new Map<string, ToolTrack>();
  /** per-session open render block */
  private blockState = new Map<string, "thinking" | "text">();
  private readonly verboseTools: boolean;

  constructor(verboseTools = false) {
    this.verboseTools = verboseTools;
  }

  /** Translate one upstream event into 0..n even-terminal messages. */
  translate(event: UpstreamEvent): Translated[] {
    const d = event.data;
    const sessionId = str(d.sessionID);
    switch (event.type) {
      case "session.execution.started":
        return sessionId ? [{ sessionId, msg: { type: "status", state: "busy", sessionId } }] : [];
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.idle":
        return sessionId ? [{ sessionId, msg: { type: "status", state: "idle", sessionId } }] : [];
      case "session.execution.failed": {
        if (!sessionId) return [];
        const message = str(rec(d.error).message) || "Agent error";
        return [
          { sessionId, msg: { type: "error", message: capText(message, 200) } },
          { sessionId, msg: { type: "status", state: "idle", sessionId } },
        ];
      }
      case "session.retry.scheduled": {
        if (!sessionId) return [];
        const attempt = typeof d.attempt === "number" ? ` (attempt ${d.attempt})` : "";
        const reason = str(rec(d.error).message);
        return [
          {
            sessionId,
            msg: { type: "notification", title: "Retrying", message: capText(`Retrying${attempt}… ${reason}`.trim(), 120) },
          },
        ];
      }
      case "session.text.started":
        return sessionId ? this.textTransition(sessionId) : [];
      case "session.text.delta":
        return this.textDelta(sessionId, d);
      case "session.text.ended":
        return this.textEnded(sessionId, d);
      case "session.reasoning.started":
      case "session.reasoning.delta":
        return sessionId ? this.thinkTransition(sessionId, true) : [];
      case "session.reasoning.ended":
        return sessionId ? this.thinkTransition(sessionId, false) : [];
      case "session.tool.input.started":
        return this.toolInputStarted(sessionId, d);
      case "session.tool.called":
        return this.toolCalled(sessionId, d);
      case "session.tool.success":
      case "session.tool.failed":
        return this.toolFinished(sessionId, d, event.type === "session.tool.failed");
      case "permission.asked":
        return this.permissionAsked(d);
      case "permission.replied":
        return this.replied(sessionId, str(d.requestID), "permission");
      case "form.created":
        return this.formCreated(d);
      case "form.replied":
      case "form.cancelled":
        return this.replied(sessionId, str(d.id), "question");
      default:
        return [];
    }
  }

  private textDelta(sessionId: string, d: Record<string, unknown>): Translated[] {
    const delta = str(d.delta);
    if (!sessionId || !delta) return [];
    const key = `${sessionId}:${str(d.assistantMessageID)}:${String(d.ordinal ?? 0)}`;
    this.streamed.set(key, (this.streamed.get(key) ?? "") + delta);
    return this.textTransition(sessionId, delta);
  }

  /** On text end, emit whatever was not streamed (e.g. bridge connected mid-block). */
  private textEnded(sessionId: string, d: Record<string, unknown>): Translated[] {
    if (!sessionId) return [];
    const key = `${sessionId}:${str(d.assistantMessageID)}:${String(d.ordinal ?? 0)}`;
    const full = str(d.text);
    const prev = this.streamed.get(key) ?? "";
    this.streamed.delete(key);
    if (!full || full === prev) return [];
    const rest = full.startsWith(prev) ? full.slice(prev.length) : prev ? "" : full;
    return rest ? this.textTransition(sessionId, rest) : [];
  }

  /** Entering/leaving a thinking block. */
  private thinkTransition(sessionId: string, entering: boolean): Translated[] {
    const current = this.blockState.get(sessionId);
    const out: Translated[] = [];
    if (entering) {
      if (current === "thinking") return [];
      if (current === "text") out.push({ sessionId, msg: { type: "status", state: "text_end", sessionId } });
      this.blockState.set(sessionId, "thinking");
      out.push({ sessionId, msg: { type: "status", state: "think_start", sessionId } });
      return out;
    }
    if (current === "thinking") {
      this.blockState.delete(sessionId);
      return [{ sessionId, msg: { type: "status", state: "think_end", sessionId } }];
    }
    return [];
  }

  /** Entering (or continuing) a text block. */
  private textTransition(sessionId: string, delta?: string): Translated[] {
    const out: Translated[] = [];
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

  /** Close any open block (on tool start or idle). */
  closeBlock(sessionId: string): Translated[] {
    const current = this.blockState.get(sessionId);
    if (!current) return [];
    this.blockState.delete(sessionId);
    return [{ sessionId, msg: { type: "status", state: current === "thinking" ? "think_end" : "text_end", sessionId } }];
  }

  private isQuiet(name: string): boolean {
    return !this.verboseTools && QUIET_TOOLS.has(name.toLowerCase());
  }

  private toolInputStarted(sessionId: string, d: Record<string, unknown>): Translated[] {
    const toolId = str(d.id);
    if (!sessionId || !toolId) return [];
    const name = str(d.name) || "tool";
    const key = `${sessionId}:${toolId}`;
    const blockClose = this.closeBlock(sessionId);
    const quiet = this.isQuiet(name);
    this.tools.set(key, { name, input: {}, started: !quiet });
    if (quiet) return blockClose;
    return [...blockClose, { sessionId, msg: { type: "tool_start", name, toolId } }];
  }

  private toolCalled(sessionId: string, d: Record<string, unknown>): Translated[] {
    const toolId = str(d.id);
    if (!sessionId || !toolId) return [];
    const key = `${sessionId}:${toolId}`;
    const track = this.tools.get(key) ?? { name: "tool", input: {}, started: false };
    track.input = rec(d.input);
    this.tools.set(key, track);
    return [];
  }

  private toolFinished(sessionId: string, d: Record<string, unknown>, failed: boolean): Translated[] {
    const toolId = str(d.id);
    if (!sessionId || !toolId) return [];
    const key = `${sessionId}:${toolId}`;
    const track = this.tools.get(key) ?? { name: "tool", input: {}, started: false };
    this.tools.delete(key);
    const { name, input } = track;
    const progress = TODO_TOOLS.has(name.toLowerCase()) ? taskProgressFromTodos(input) : null;
    if (this.isQuiet(name)) return progress ? [{ sessionId, msg: progress }] : [];

    const out: Translated[] = [];
    if (!track.started) {
      out.push(...this.closeBlock(sessionId));
      out.push({ sessionId, msg: { type: "tool_start", name, toolId } });
    }
    const errorText = failed ? str(rec(d.error).message) : "";
    const summary = toolSummary(name, input) + (failed ? " ✗" : "");
    out.push({
      sessionId,
      msg: {
        type: "tool_end",
        name,
        toolId,
        summary,
        // quiet mode keeps cards to a single line; detail is verbose-only
        ...(this.verboseTools
          ? {
              detail: {
                input: toolDetailInput(name, input),
                output: capText(errorText || toolOutputText(d.content), 200),
              },
            }
          : {}),
      },
    });
    if (progress) out.push({ sessionId, msg: progress });
    return out;
  }

  /** Bound memory: drop the oldest tracked entries when over budget. */
  prune(maxParts = 512, maxTools = 128): void {
    trimMap(this.streamed, maxParts);
    trimMap(this.tools, maxTools);
    trimMap(this.blockState, 64);
  }

  private permissionAsked(d: Record<string, unknown>): Translated[] {
    const p = d as unknown as OcPermission;
    const sessionId = str(p.sessionID);
    const requestId = str(p.id);
    if (!sessionId || !requestId) return [];
    return [
      {
        sessionId,
        msg: permissionRequestMessage(p),
        ask: { kind: "permission", requestId, questions: [] },
      },
    ];
  }

  private formCreated(d: Record<string, unknown>): Translated[] {
    const form = rec(d.form) as unknown as OcForm;
    const sessionId = str(form.sessionID);
    const requestId = str(form.id);
    if (!sessionId || !requestId) return [];
    const msg = formQuestionMessage(form);
    if (!msg) return [];
    return [{ sessionId, msg, ask: { kind: "question", requestId, questions: formAskQuestions(form) } }];
  }

  /** A pending ask was answered elsewhere (OpenChamber UI / auto-accept). */
  private replied(sessionId: string, requestId: string, kind: "permission" | "question"): Translated[] {
    if (!requestId) return [];
    return [
      {
        sessionId,
        msg: {
          type: "notification",
          message: kind === "question" ? "Question answered elsewhere" : "Permission handled outside the glasses",
        },
        reply: { kind, requestId },
      },
    ];
  }
}

// ── REST shape mapping ───────────────────────────────────

const IGNORED_TITLE = /^(New session|Untitled|session) - /;

/** Root, non-archived, titled sessions sorted by most recent update. */
export function visibleRootSessions(list: OcSession[]): OcSession[] {
  return list
    .filter((s) => !s.time?.archived && !s.parentID)
    .filter((s) => !IGNORED_TITLE.test(s.title ?? ""))
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
}

export function toEvenSession(s: OcSession, label?: string): EvenSession {
  const base = (s.title || s.id).trim();
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
  const t = activity[sessionId]?.type;
  return t === "running" || t === "busy" ? "busy" : "idle";
}

/** Flatten v2 messages into terminal-style history rows, newest last. */
export function toHistoryRows(messages: OcMessage[], limit: number, maxChars = 4000): HistoryItem[] {
  const rows: HistoryItem[] = [];
  for (const m of messages) {
    if (m.type === "user") {
      const text = (m.text ?? "").trim();
      if (text) rows.push({ role: "user", text: `you: ${text}` });
    } else if (m.type === "assistant") {
      for (const c of m.content ?? []) {
        if (c.type === "text") {
          const text = c.text.trim();
          if (text) rows.push({ role: "assistant", text });
        } else if (c.type === "tool") {
          rows.push({ role: "tool", text: `> ${c.name}: ${toolSummary(c.name, rec(c.state?.input))}` });
        }
      }
    } else if (m.type === "shell" && m.command) {
      rows.push({ role: "tool", text: `> $ ${capText(m.command, 80)}` });
    }
  }
  const out: HistoryItem[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    used += rows[i]!.text.length + 1;
    if (used > maxChars) break;
    out.unshift(rows[i]!);
  }
  return out;
}

// ── Permissions & questions ──────────────────────────────

export function buildPermissionOptions(alwaysLabel = "Yes, and always allow"): Array<{ text: string; key: string }> {
  return [
    { text: "Yes", key: "allow" },
    { text: alwaysLabel, key: "allowAlways" },
    { text: "No", key: "deny" },
  ];
}

/** Pending v2 permission request -> permission_request message for the glasses. */
export function permissionRequestMessage(p: OcPermission): EvenMessage {
  const action = str(p.action) || "permission";
  const resources = Array.isArray(p.resources) ? p.resources.map(String) : [];
  const description = str(p.message) || (resources[0] ? `${action}: ${capText(resources[0], 60)}` : action);
  return {
    type: "permission_request",
    toolName: action,
    description,
    detail: resources.join(", ").slice(0, 200),
    toolUseId: str(p.id),
    options: buildPermissionOptions(),
    suggestions: null,
  };
}

/** Map an app decision ("allow" | "allowAlways" | "deny") to opencode's reply verb. */
export function decisionToResponse(decision: string): OcPermissionReply {
  if (decision === "allowAlways") return "always";
  if (decision === "allow") return "once";
  return "reject";
}

function askableFields(form: OcForm): OcFormField[] {
  return (Array.isArray(form.fields) ? form.fields : []).filter((f) => !f.hidden && f.type !== "external");
}

function fieldOptions(field: OcFormField): Array<{ label: string; description: string; preview: string }> {
  if (field.type === "boolean") {
    return [
      { label: "Yes", description: "", preview: "" },
      { label: "No", description: "", preview: "" },
    ];
  }
  return (field.options ?? []).map((o) => ({ label: str(o.label) || str(o.value), description: str(o.description), preview: "" }));
}

/** Question text per askable form field (unique, so JSON answer maps stay unambiguous). */
export function formAskQuestions(form: OcForm): AskQuestion[] {
  const fields = askableFields(form);
  const seen = new Set<string>();
  return fields.map((field) => {
    let question = str(field.title) || str(field.description) || str(form.title) || field.key;
    if (seen.has(question)) question = `${question} (${field.key})`;
    seen.add(question);
    return { question, header: fields.length > 1 || field.title ? str(form.title) : "", field };
  });
}

/** v2 form (ask-user) -> user_question message for the glasses. */
export function formQuestionMessage(form: OcForm): EvenMessage | null {
  const asks = formAskQuestions(form);
  if (asks.length === 0) return null;
  return {
    type: "user_question",
    questions: asks.map((a) => ({
      question: a.question,
      header: a.header ?? "",
      options: a.field ? fieldOptions(a.field) : [],
    })),
    toolUseId: str(form.id),
  };
}

/**
 * The app replies with either plain text (first question) or a JSON map of
 * {questionOrHeader: label}. Normalize to ordered answer strings.
 */
export function parseQuestionAnswer(answer: string, questions: Array<{ question?: string; header?: string }>): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.trim());
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const map = parsed as Record<string, unknown>;
    return questions.map((q) => {
      const value = map[q.question ?? ""] ?? map[q.header ?? ""];
      return typeof value === "string" ? value : "";
    });
  }
  if (Array.isArray(parsed)) return parsed.map((a) => String(a));
  const plain = answer.trim();
  return questions.map(() => plain);
}

function optionValue(field: OcFormField, label: string): string {
  const needle = label.trim().toLowerCase();
  const hit = (field.options ?? []).find(
    (o) => str(o.label).toLowerCase() === needle || str(o.value).toLowerCase() === needle,
  );
  return hit ? hit.value : label.trim();
}

/** Ordered app answers (labels or free text) -> v2 `Form.Reply.answer` keyed by field. */
export function formAnswerFromLabels(asks: AskQuestion[], answers: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  asks.forEach((ask, i) => {
    const field = ask.field;
    const raw = (answers[i] ?? "").trim();
    if (!field || !raw) return;
    switch (field.type) {
      case "boolean":
        out[field.key] = /^(y|yes|true|ok|allow)$/i.test(raw);
        break;
      case "number":
      case "integer": {
        const n = Number(raw);
        if (Number.isFinite(n)) out[field.key] = field.type === "integer" ? Math.round(n) : n;
        break;
      }
      case "multiselect":
        out[field.key] = raw
          .split(/\s*,\s*/)
          .filter(Boolean)
          .map((label) => optionValue(field, label));
        break;
      default:
        out[field.key] = optionValue(field, raw);
    }
  });
  return out;
}

/** Last assistant text of a message list (for the result message on idle). */
export function lastAssistantText(messages: OcMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "user") break; // don't reach into the previous turn
    if (m.type !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text?.trim())
      .map((c) => c.text.trim())
      .join("\n");
    if (text) return text;
  }
  return "";
}

/** Turn stats summed over assistant steps since the last user message. */
export function lastAssistantUsage(messages: OcMessage[]): {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turns: number;
} {
  const totals = { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "user") break; // turn boundary
    if (m.type !== "assistant") continue;
    totals.turns++;
    totals.inputTokens += m.tokens?.input ?? 0;
    totals.outputTokens += m.tokens?.output ?? 0;
    totals.cost += m.cost ?? 0;
  }
  return totals;
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
  // OpenChamber's internal chat dirs have no project — label them "chat"
  if (dir.includes("/.config/openchamber/chats/")) return "chat";
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
  // longest matching worktree wins (nested projects)
  const worktree =
    parent ??
    [...byWorktree.keys()]
      .filter((wt) => dir === wt || dir.startsWith(wt + "/"))
      .sort((a, b) => b.length - a.length)[0];
  if (!worktree) return abbrevLabel(aliases?.get(dir) ?? basename(directory));
  return abbrevLabel(aliases?.get(worktree) ?? basename(worktree));
}
