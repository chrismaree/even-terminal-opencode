import { test } from "node:test";
import assert from "node:assert/strict";
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
  sessionState,
  toHistoryRows,
  toEvenSession,
  toolSummary,
  visibleRootSessions,
  projectLabelFor,
  abbrevLabel,
} from "../src/translate.ts";
import type { OcForm, OcMessage } from "../src/openchamber.ts";
import type { UpstreamEvent } from "../src/sse.ts";

const ev = (type: string, data: Record<string, unknown>): UpstreamEvent => ({ type, data });

const states = (out: Array<{ msg: { type: string } }>) =>
  out.map((o) => (o.msg.type === "status" ? (o.msg as unknown as { state: string }).state : o.msg.type));

/** Feeds a full v2 tool lifecycle and returns everything emitted. */
function runTool(
  t: OpencodeEventTranslator,
  name: string,
  input: Record<string, unknown>,
  opts: { id?: string; sessionID?: string; failed?: string; output?: string } = {},
) {
  const sessionID = opts.sessionID ?? "s";
  const id = opts.id ?? `t-${name}`;
  const started = t.translate(ev("session.tool.input.started", { sessionID, assistantMessageID: "a1", id, name }));
  const called = t.translate(ev("session.tool.called", { sessionID, id, input }));
  const ended = opts.failed
    ? t.translate(ev("session.tool.failed", { sessionID, id, error: { message: opts.failed } }))
    : t.translate(ev("session.tool.success", { sessionID, id, content: [{ type: "text", text: opts.output ?? "ok" }] }));
  return { started, called, ended, all: [...started, ...called, ...ended] };
}

// ── session lifecycle ───────────────────────────────────

test("execution started/succeeded/interrupted and session.idle map to busy/idle", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(t.translate(ev("session.execution.started", { sessionID: "s1" })), [
    { sessionId: "s1", msg: { type: "status", state: "busy", sessionId: "s1" } },
  ]);
  for (const type of ["session.execution.succeeded", "session.execution.interrupted", "session.idle"]) {
    assert.deepEqual(t.translate(ev(type, { sessionID: "s1" })), [
      { sessionId: "s1", msg: { type: "status", state: "idle", sessionId: "s1" } },
    ]);
  }
  // no session id -> nothing
  assert.deepEqual(t.translate(ev("session.execution.started", {})), []);
  // unknown events are ignored
  assert.deepEqual(t.translate(ev("session.usage.updated", { sessionID: "s1" })), []);
});

test("session.execution.failed maps to an error card followed by idle", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(t.translate(ev("session.execution.failed", { sessionID: "s1", error: { message: "model overloaded" } })), [
    { sessionId: "s1", msg: { type: "error", message: "model overloaded" } },
    { sessionId: "s1", msg: { type: "status", state: "idle", sessionId: "s1" } },
  ]);
  // long messages are capped, missing messages get a default
  const long = t.translate(ev("session.execution.failed", { sessionID: "s1", error: { message: "e".repeat(500) } }));
  assert.equal((long[0]!.msg as { message: string }).message.length, 201);
  const bare = t.translate(ev("session.execution.failed", { sessionID: "s1" }));
  assert.equal((bare[0]!.msg as { message: string }).message, "Agent error");
});

test("session.retry.scheduled maps to a Retrying notification", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(t.translate(ev("session.retry.scheduled", { sessionID: "s1" })), [
    { sessionId: "s1", msg: { type: "notification", title: "Retrying", message: "Retrying…" } },
  ]);
  assert.deepEqual(
    t.translate(ev("session.retry.scheduled", { sessionID: "s1", attempt: 2, error: { message: "rate limited" } })),
    [{ sessionId: "s1", msg: { type: "notification", title: "Retrying", message: "Retrying (attempt 2)… rate limited" } }],
  );
});

// ── text ────────────────────────────────────────────────

test("session.text.delta streams incremental text with a single text_start", () => {
  const t = new OpencodeEventTranslator();
  const delta = (d: string) =>
    ev("session.text.delta", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 0, delta: d });
  assert.deepEqual(t.translate(ev("session.text.started", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 0 })), [
    { sessionId: "ses1", msg: { type: "status", state: "text_start", sessionId: "ses1" } },
  ]);
  assert.deepEqual(t.translate(delta("Hello")), [{ sessionId: "ses1", msg: { type: "text_delta", text: "Hello" } }]);
  assert.deepEqual(t.translate(delta(" world")), [{ sessionId: "ses1", msg: { type: "text_delta", text: " world" } }]);
  // empty deltas ignored
  assert.deepEqual(t.translate(delta("")), []);
  // text.ended with the fully streamed text emits nothing more
  assert.deepEqual(
    t.translate(ev("session.text.ended", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 0, text: "Hello world" })),
    [],
  );
});

test("a delta without text.started still opens the text block", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(t.translate(ev("session.text.delta", { sessionID: "s", assistantMessageID: "a", ordinal: 0, delta: "Hi" })), [
    { sessionId: "s", msg: { type: "status", state: "text_start", sessionId: "s" } },
    { sessionId: "s", msg: { type: "text_delta", text: "Hi" } },
  ]);
});

test("session.text.ended emits the remainder when deltas were missed", () => {
  const t = new OpencodeEventTranslator();
  t.translate(ev("session.text.delta", { sessionID: "s", assistantMessageID: "a", ordinal: 1, delta: "abc" }));
  assert.deepEqual(t.translate(ev("session.text.ended", { sessionID: "s", assistantMessageID: "a", ordinal: 1, text: "abcdef" })), [
    { sessionId: "s", msg: { type: "text_delta", text: "def" } },
  ]);
  // bridge connected mid-block: nothing streamed -> the full text
  const fresh = new OpencodeEventTranslator();
  assert.deepEqual(
    fresh.translate(ev("session.text.ended", { sessionID: "s", assistantMessageID: "b", ordinal: 0, text: "full answer" })),
    [
      { sessionId: "s", msg: { type: "status", state: "text_start", sessionId: "s" } },
      { sessionId: "s", msg: { type: "text_delta", text: "full answer" } },
    ],
  );
  // ordinals are tracked independently
  const multi = new OpencodeEventTranslator();
  multi.translate(ev("session.text.delta", { sessionID: "s", assistantMessageID: "a", ordinal: 0, delta: "one" }));
  assert.deepEqual(
    multi.translate(ev("session.text.ended", { sessionID: "s", assistantMessageID: "a", ordinal: 2, text: "two" })),
    [{ sessionId: "s", msg: { type: "text_delta", text: "two" } }],
  );
});

// ── reasoning ───────────────────────────────────────────

test("reasoning becomes thinking states, never raw text", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(t.translate(ev("session.reasoning.started", { sessionID: "s", assistantMessageID: "a", ordinal: 0 })), [
    { sessionId: "s", msg: { type: "status", state: "think_start", sessionId: "s" } },
  ]);
  // reasoning deltas (would leak chain-of-thought) are fully suppressed
  assert.deepEqual(
    t.translate(ev("session.reasoning.delta", { sessionID: "s", assistantMessageID: "a", ordinal: 0, delta: "secret reasoning" })),
    [],
  );
  assert.deepEqual(t.translate(ev("session.reasoning.ended", { sessionID: "s", text: "secret reasoning" })), [
    { sessionId: "s", msg: { type: "status", state: "think_end", sessionId: "s" } },
  ]);
  // a second ended is a no-op
  assert.deepEqual(t.translate(ev("session.reasoning.ended", { sessionID: "s" })), []);
});

test("text arriving while thinking closes the thinking block first", () => {
  const t = new OpencodeEventTranslator();
  t.translate(ev("session.reasoning.started", { sessionID: "s" }));
  const out = t.translate(ev("session.text.delta", { sessionID: "s", assistantMessageID: "a", ordinal: 1, delta: "The answer" }));
  assert.deepEqual(states(out), ["think_end", "text_start", "text_delta"]);
  assert.equal((out[2]!.msg as { text: string }).text, "The answer");
  // and reasoning after text closes the text block
  assert.deepEqual(states(t.translate(ev("session.reasoning.started", { sessionID: "s" }))), ["text_end", "think_start"]);
});

test("reasoning.delta without a started event still opens thinking", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(states(t.translate(ev("session.reasoning.delta", { sessionID: "s", delta: "x" }))), ["think_start"]);
});

test("closeBlock closes the open block once", () => {
  const t = new OpencodeEventTranslator();
  t.translate(ev("session.text.delta", { sessionID: "s", assistantMessageID: "a", delta: "x" }));
  assert.deepEqual(t.closeBlock("s"), [{ sessionId: "s", msg: { type: "status", state: "text_end", sessionId: "s" } }]);
  assert.deepEqual(t.closeBlock("s"), []);
});

// ── tools ───────────────────────────────────────────────

test("tools emit tool_start on input.started and tool_end on success", () => {
  const t = new OpencodeEventTranslator();
  t.translate(ev("session.text.delta", { sessionID: "ses1", assistantMessageID: "a", delta: "let me look" }));
  const { started, called, ended } = runTool(t, "shell", { command: "ls -la" }, { sessionID: "ses1", id: "call1" });
  assert.deepEqual(started, [
    { sessionId: "ses1", msg: { type: "status", state: "text_end", sessionId: "ses1" } },
    { sessionId: "ses1", msg: { type: "tool_start", name: "shell", toolId: "call1" } },
  ]);
  assert.deepEqual(called, []);
  assert.deepEqual(ended, [
    { sessionId: "ses1", msg: { type: "tool_end", name: "shell", toolId: "call1", summary: "ls -la" } },
  ]);
});

test("tool_end without a seen input.started emits a start+end pair", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate(ev("session.tool.success", { sessionID: "s", id: "call2", content: [] }));
  assert.deepEqual(states(out), ["tool_start", "tool_end"]);
  assert.equal((out[0]!.msg as { name: string }).name, "tool");
  // called-only (bridge connected mid-tool) keeps the input for the summary
  const t2 = new OpencodeEventTranslator();
  t2.translate(ev("session.tool.called", { sessionID: "s", id: "c3", input: { description: "run make" } }));
  const out2 = t2.translate(ev("session.tool.success", { sessionID: "s", id: "c3" }));
  assert.deepEqual(states(out2), ["tool_start", "tool_end"]);
  assert.equal((out2[1]!.msg as { summary: string }).summary, "run make");
});

test("session.tool.failed marks the card and carries the error in verbose detail", () => {
  const quiet = runTool(new OpencodeEventTranslator(), "shell", { command: "false" }, { failed: "exit 1" });
  const end = quiet.ended.find((o) => o.msg.type === "tool_end")!.msg as { summary: string; detail?: unknown };
  assert.equal(end.summary, "false ✗");
  assert.equal(end.detail, undefined);
  const verbose = runTool(new OpencodeEventTranslator(true), "shell", { command: "false" }, { failed: "exit 1" });
  const vend = verbose.ended.find((o) => o.msg.type === "tool_end")!.msg as { detail: { input?: string; output?: string } };
  assert.deepEqual(vend.detail, { input: "false", output: "exit 1" });
});

test("quiet mode hides read-only tool cards, verbose shows them", () => {
  const quiet = new OpencodeEventTranslator();
  assert.deepEqual(runTool(quiet, "read", { path: "/a/b.ts" }).all, []);
  assert.deepEqual(runTool(quiet, "grep", { pattern: "foo" }).all, []);
  assert.deepEqual(runTool(quiet, "skill", { id: "x" }).all, []);
  // action tools still render in quiet mode
  assert.deepEqual(states(runTool(quiet, "shell", { command: "npm run build" }).all), ["tool_start", "tool_end"]);
  const verbose = new OpencodeEventTranslator(true);
  assert.deepEqual(states(runTool(verbose, "read", { path: "/a/b.ts" }).all), ["tool_start", "tool_end"]);
});

test("a quiet tool still closes an open text block", () => {
  const t = new OpencodeEventTranslator();
  t.translate(ev("session.text.delta", { sessionID: "s", assistantMessageID: "a", delta: "x" }));
  assert.deepEqual(states(runTool(t, "read", { path: "/x" }).all), ["text_end"]);
});

test("tool summaries are compact and v2-name aware", () => {
  const t = new OpencodeEventTranslator();
  const summary = (name: string, input: Record<string, unknown>) =>
    (runTool(t, name, input).ended.find((o) => o.msg.type === "tool_end")!.msg as { summary: string; detail?: unknown });
  assert.equal(summary("shell", { command: "npm run build\nmore" }).summary, "npm run build");
  assert.equal(summary("edit", { path: "/a/b/app.ts", newString: "a\nb", oldString: "x" }).summary, "app.ts +1");
  assert.equal(summary("edit", { path: "/a/b/app.ts", newString: "a", oldString: "x\ny\nz" }).summary, "app.ts -2");
  assert.equal(summary("write", { path: "/a/b/new.ts" }).summary, "new.ts");
  assert.equal(summary("webfetch", { url: "https://example.com/docs" }).summary, "example.com/docs");
  assert.equal(summary("websearch", { query: "node sse" }).summary, "node sse");
  assert.equal(summary("subagent", { description: "explore the repo" }).summary, "explore the repo");
  // quiet mode keeps cards summary-only
  assert.equal(summary("write", { path: "/a/new.ts" }).detail, undefined);

  // pure helper covers the quiet tools too
  assert.equal(toolSummary("read", { path: "/a/b/c.ts" }), "c.ts");
  assert.equal(toolSummary("grep", { pattern: "TODO" }), "TODO");
  assert.equal(toolSummary("skill", { id: "release-docs" }), "release-docs");
  assert.equal(toolSummary("shell", {}), "command");
  assert.equal(toolSummary("mcp_thing", { description: "do x" }), "do x");
  assert.equal(toolSummary("mcp_thing", {}), "mcp_thing");
  assert.equal(toolSummary("shell", { command: "x".repeat(80) }).length, 51);

  // verbose restores detail: shell keeps its command, output is capped
  const v = new OpencodeEventTranslator(true);
  const detail = (name: string, input: Record<string, unknown>) =>
    (runTool(v, name, input, { output: "x".repeat(400) }).ended.find((o) => o.msg.type === "tool_end")!.msg as {
      detail: { input?: unknown; output?: string };
    }).detail;
  const shellDetail = detail("shell", { command: "ls -la" });
  assert.equal(shellDetail.input, "ls -la");
  assert.equal(shellDetail.output!.length, 201);
  assert.equal(detail("write", { path: "/a/new.ts" }).input, undefined);
});

test("todowrite completion emits task_progress without a tool card", () => {
  const t = new OpencodeEventTranslator();
  const { all } = runTool(t, "todowrite", {
    todos: [
      { content: "wire the bridge", status: "completed" },
      { content: "pair the glasses", status: "in_progress" },
      { content: "polish visuals", status: "pending" },
    ],
  });
  assert.deepEqual(all, [
    { sessionId: "s", msg: { type: "task_progress", completed: 1, total: 3, current: "pair the glasses" } },
  ]);
});

test("the question tool card is hidden (user_question drives the UI)", () => {
  assert.deepEqual(runTool(new OpencodeEventTranslator(), "question", {}).all, []);
});

test("translator state is bounded via prune", () => {
  const t = new OpencodeEventTranslator();
  for (let i = 0; i < 1000; i++) {
    t.translate(ev("session.text.delta", { sessionID: `s${i}`, assistantMessageID: `m${i}`, delta: "x" }));
    t.translate(ev("session.tool.input.started", { sessionID: `s${i}`, id: `t${i}`, name: "shell" }));
  }
  t.prune(100, 50);
  const internals = t as unknown as { streamed: Map<unknown, unknown>; tools: Map<unknown, unknown>; blockState: Map<unknown, unknown> };
  assert.ok(internals.streamed.size <= 100);
  assert.ok(internals.tools.size <= 50);
  assert.ok(internals.blockState.size <= 64);
});

// ── permissions & forms (events) ────────────────────────

test("permission.asked translates to permission_request with ask bookkeeping", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate(
    ev("permission.asked", { id: "r1", sessionID: "s1", action: "shell", resources: ["rm -rf build"], save: ["rm *"] }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sessionId, "s1");
  assert.equal(out[0]!.msg.type, "permission_request");
  const msg = out[0]!.msg as { toolName: string; description: string; toolUseId: string };
  assert.equal(msg.toolName, "shell");
  assert.equal(msg.description, "shell: rm -rf build");
  assert.equal(msg.toolUseId, "r1");
  assert.deepEqual(out[0]!.ask, { kind: "permission", requestId: "r1", questions: [] });
  // missing id/session -> nothing
  assert.deepEqual(t.translate(ev("permission.asked", { sessionID: "s1", action: "shell" })), []);
});

test("form.created translates to user_question with ask bookkeeping", () => {
  const t = new OpencodeEventTranslator();
  const field = {
    key: "db",
    type: "select",
    title: "Which DB?",
    options: [
      { value: "sqlite", label: "SQLite", description: "embedded" },
      { value: "pg", label: "Postgres" },
    ],
  };
  const out = t.translate(ev("form.created", { form: { id: "f1", sessionID: "s1", title: "Choice", fields: [field] } }));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.msg, {
    type: "user_question",
    questions: [
      {
        question: "Which DB?",
        header: "Choice",
        options: [
          { label: "SQLite", description: "embedded", preview: "" },
          { label: "Postgres", description: "", preview: "" },
        ],
      },
    ],
    toolUseId: "f1",
  });
  assert.equal(out[0]!.ask?.kind, "question");
  assert.equal(out[0]!.ask?.requestId, "f1");
  assert.deepEqual(out[0]!.ask?.questions, [{ question: "Which DB?", header: "Choice", field }]);
  // no askable fields -> nothing
  assert.deepEqual(
    t.translate(ev("form.created", { form: { id: "f2", sessionID: "s1", title: "x", fields: [{ key: "h", type: "text", hidden: true }] } })),
    [],
  );
  assert.deepEqual(t.translate(ev("form.created", { form: { sessionID: "s1", fields: [field] } })), []);
});

test("form.replied / form.cancelled / permission.replied produce reply bookkeeping", () => {
  const t = new OpencodeEventTranslator();
  for (const type of ["form.replied", "form.cancelled"]) {
    const out = t.translate(ev(type, { id: "f9", sessionID: "s1" }));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.reply, { kind: "question", requestId: "f9" });
    assert.equal(out[0]!.msg.type, "notification");
  }
  const perm = t.translate(ev("permission.replied", { sessionID: "s1", requestID: "r9", reply: "once" }));
  assert.deepEqual(perm[0]!.reply, { kind: "permission", requestId: "r9" });
  assert.deepEqual(t.translate(ev("permission.replied", { sessionID: "s1" })), []);
});

// ── REST shapes ─────────────────────────────────────────

test("visibleRootSessions filters archived/subagents/untitled and sorts", () => {
  const now = 10_000;
  const rows = visibleRootSessions([
    { id: "a", title: "Fix bug", time: { updated: now } },
    { id: "b", title: "archived", time: { updated: now + 5, archived: now + 5 } },
    { id: "c", title: "subagent", parentID: "a", time: { updated: now + 9 } },
    { id: "d", title: "New session - xyz", time: { updated: now + 8 } },
    { id: "e", title: "Newer", time: { updated: now + 1 } },
    { id: "f", title: "null parent", parentID: null, time: { updated: now - 1 } },
  ]);
  assert.deepEqual(
    rows.map((s) => s.id),
    ["e", "a", "f"],
  );
});

test("toEvenSession maps shape", () => {
  const s = toEvenSession({ id: "id1", title: "T", directory: "/tmp/x", time: { updated: 1_700_000_000_000 } });
  assert.deepEqual(s, {
    id: "id1",
    title: "T",
    timestamp: new Date(1_700_000_000_000).toISOString(),
    cwd: "/tmp/x",
    provider: "claude",
    status: null,
  });
});

test("toEvenSession prefixes title with label, capped at 64", () => {
  const out = toEvenSession({ id: "id1", title: "T", directory: "/x/mono", time: { updated: 1 } }, "grok-bot");
  assert.equal(out.title, "grok-bot · T");
  const long = toEvenSession({ id: "x", title: "y".repeat(80), directory: "/x/mono", time: {} }, "grok-bot");
  assert.equal(long.title.length, 64);
  assert.ok(long.title.startsWith("grok-bot · "));
});

test("sessionState: awaiting beats running, running/busy are busy", () => {
  assert.equal(sessionState({ s: { type: "running" } }, "s", false), "busy");
  assert.equal(sessionState({ s: { type: "busy" } }, "s", false), "busy");
  assert.equal(sessionState({ s: { type: "running" } }, "s", true), "awaiting");
  assert.equal(sessionState({}, "s", false), "idle");
});

test("toHistoryRows flattens user/assistant/tool/shell rows, capped", () => {
  const messages: OcMessage[] = [
    { id: "m1", type: "user", text: "hi" },
    {
      id: "m2",
      type: "assistant",
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "tool", id: "t1", name: "shell", state: { status: "completed", input: { command: "ls" } } },
        { type: "text", text: "done" },
      ],
    },
    { id: "m3", type: "shell", command: "git status" },
    { id: "m4", type: "idle" },
    { id: "m5", type: "user", text: "   " },
  ];
  assert.deepEqual(toHistoryRows(messages, 10), [
    { role: "user", text: "you: hi" },
    { role: "tool", text: "> shell: ls" },
    { role: "assistant", text: "done" },
    { role: "tool", text: "> $ git status" },
  ]);
  // limit keeps the newest rows
  assert.deepEqual(toHistoryRows(messages, 2), [
    { role: "assistant", text: "done" },
    { role: "tool", text: "> $ git status" },
  ]);
});

test("toHistoryRows respects char budget", () => {
  const rows = toHistoryRows(
    [
      { id: "m1", type: "assistant", content: [{ type: "text", text: "x".repeat(50) }] },
      { id: "m2", type: "assistant", content: [{ type: "text", text: "y".repeat(30) }] },
    ],
    10,
    40,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.text, /^y+$/);
});

test("lastAssistantText picks the last assistant text of the current turn", () => {
  const text = lastAssistantText([
    { id: "m0", type: "assistant", content: [{ type: "text", text: "old answer" }] },
    { id: "m1", type: "user", text: "q" },
    {
      id: "m2",
      type: "assistant",
      content: [
        { type: "tool", id: "t", name: "x", state: {} },
        { type: "text", text: "answer" },
        { type: "text", text: "part two" },
      ],
    },
    { id: "m3", type: "assistant", content: [{ type: "reasoning", text: "hmm" }] },
    { id: "m4", type: "idle" },
  ]);
  assert.equal(text, "answer\npart two");
  // never reaches into the previous turn
  assert.equal(
    lastAssistantText([
      { id: "a", type: "assistant", content: [{ type: "text", text: "old" }] },
      { id: "u", type: "user", text: "new q" },
    ]),
    "",
  );
  assert.equal(lastAssistantText([]), "");
});

test("lastAssistantUsage sums assistant steps since the last user message", () => {
  const usage = lastAssistantUsage([
    { id: "a0", type: "assistant", cost: 9, tokens: { input: 900, output: 900 } },
    { id: "u", type: "user", text: "go" },
    { id: "a1", type: "assistant", cost: 0.01, tokens: { input: 100, output: 20 } },
    { id: "s", type: "synthetic", text: "tool result" },
    { id: "a2", type: "assistant", cost: 0.02, tokens: { input: 150, output: 30 } },
    { id: "a3", type: "assistant" },
  ]);
  assert.equal(usage.turns, 3);
  assert.equal(usage.inputTokens, 250);
  assert.equal(usage.outputTokens, 50);
  assert.ok(Math.abs(usage.cost - 0.03) < 1e-9);
  assert.deepEqual(lastAssistantUsage([]), { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 });
});

// ── permissions & questions (pure helpers) ──────────────

test("permissionRequestMessage builds options and detail", () => {
  const msg = permissionRequestMessage({
    id: "req1",
    sessionID: "s1",
    action: "shell",
    resources: ["git push", "npm publish"],
  });
  assert.equal(msg.type, "permission_request");
  const p = msg as { toolName: string; description: string; detail: string; toolUseId: string; options: Array<{ key: string }> };
  assert.equal(p.toolName, "shell");
  assert.equal(p.description, "shell: git push");
  assert.equal(p.detail, "git push, npm publish");
  assert.equal(p.toolUseId, "req1");
  assert.deepEqual(
    p.options.map((o) => o.key),
    ["allow", "allowAlways", "deny"],
  );
  // an explicit message wins; no resources -> bare action
  const withMessage = permissionRequestMessage({ id: "r2", sessionID: "s", action: "edit", message: "Edit app.ts?" });
  assert.equal((withMessage as { description: string }).description, "Edit app.ts?");
  assert.equal((withMessage as { detail: string }).detail, "");
  const bare = permissionRequestMessage({ id: "r3", sessionID: "s", action: "webfetch" });
  assert.equal((bare as { description: string }).description, "webfetch");
});

test("decisionToResponse maps app decisions to opencode reply verbs", () => {
  assert.equal(decisionToResponse("allow"), "once");
  assert.equal(decisionToResponse("allowAlways"), "always");
  assert.equal(decisionToResponse("deny"), "reject");
  assert.equal(decisionToResponse("whatever"), "reject");
});

test("formQuestionMessage/formAskQuestions map fields, skip hidden/external, dedupe questions", () => {
  const form: OcForm = {
    id: "f1",
    sessionID: "s",
    title: "Setup",
    fields: [
      { key: "ok", type: "boolean", title: "Proceed?" },
      { key: "a", type: "text", title: "Name?" },
      { key: "b", type: "text", title: "Name?" },
      { key: "h", type: "text", title: "hidden", hidden: true },
      { key: "x", type: "external", title: "external" },
      { key: "d", type: "text", description: "Describe it" },
    ],
  };
  const asks = formAskQuestions(form);
  assert.deepEqual(
    asks.map((a) => a.question),
    ["Proceed?", "Name?", "Name? (b)", "Describe it"],
  );
  assert.ok(asks.every((a) => a.header === "Setup"));
  const msg = formQuestionMessage(form) as { questions: Array<{ options: Array<{ label: string }> }>; toolUseId: string };
  assert.equal(msg.toolUseId, "f1");
  assert.deepEqual(
    msg.questions[0]!.options.map((o) => o.label),
    ["Yes", "No"],
  );
  assert.deepEqual(msg.questions[1]!.options, []);
  // single untitled field falls back to the form title, no header
  const single = formAskQuestions({ id: "f2", sessionID: "s", title: "Pick one", fields: [{ key: "k", type: "select" }] });
  assert.deepEqual(single.map((a) => [a.question, a.header]), [["Pick one", ""]]);
  assert.equal(formQuestionMessage({ id: "f3", sessionID: "s", title: "t", fields: [] }), null);
});

test("parseQuestionAnswer handles plain, JSON array and JSON map", () => {
  const qs = [{ question: "Which?" }, { question: "Where?", header: "Place" }];
  assert.deepEqual(parseQuestionAnswer("A", qs), ["A", "A"]);
  assert.deepEqual(parseQuestionAnswer('["A","B"]', qs), ["A", "B"]);
  assert.deepEqual(parseQuestionAnswer('{"Which?": "A", "Where?": "B"}', qs), ["A", "B"]);
  // header fallback, missing keys -> ""
  assert.deepEqual(parseQuestionAnswer('{"Place": "home"}', qs), ["", "home"]);
  // non-JSON numbers stay plain text
  assert.deepEqual(parseQuestionAnswer(" 42 ", [{ question: "n" }]), ["42"]);
});

test("formAnswerFromLabels maps labels to option values per field type", () => {
  const asks = formAskQuestions({
    id: "f",
    sessionID: "s",
    title: "t",
    fields: [
      {
        key: "db",
        type: "select",
        title: "DB",
        options: [
          { value: "sqlite", label: "SQLite" },
          { value: "pg", label: "Postgres" },
        ],
      },
      {
        key: "langs",
        type: "multiselect",
        title: "Langs",
        options: [
          { value: "ts", label: "TypeScript" },
          { value: "py", label: "Python" },
        ],
      },
      { key: "ok", type: "boolean", title: "OK?" },
      { key: "n", type: "integer", title: "Count" },
      { key: "f", type: "number", title: "Ratio" },
      { key: "free", type: "text", title: "Notes" },
      { key: "empty", type: "text", title: "Empty" },
    ],
  });
  assert.deepEqual(
    formAnswerFromLabels(asks, ["postgres", "TypeScript, py, Rust", "Yes", "2.6", "0.5", "  hello  ", ""]),
    { db: "pg", langs: ["ts", "py", "Rust"], ok: true, n: 3, f: 0.5, free: "hello" },
  );
  assert.deepEqual(formAnswerFromLabels(asks.slice(2, 4), ["No", "abc"]), { ok: false });
  assert.deepEqual(formAnswerFromLabels(asks, []), {});
  // asks without a field (no form metadata) contribute nothing
  assert.deepEqual(formAnswerFromLabels([{ question: "q" }], ["x"]), {});
});

// ── labels ──────────────────────────────────────────────

test("projectLabelFor: sandbox maps to parent project label", () => {
  const projects = [{ id: "p1", worktree: "/Users/w/dev/mono", sandboxes: ["/tmp/wt-abc", "/tmp/wt-2"] }];
  assert.equal(projectLabelFor("/tmp/wt-abc/inner", projects), "mono"); // sandbox subdir
  assert.equal(projectLabelFor("/tmp/wt-abc", projects), "mono"); // exact sandbox
  assert.equal(projectLabelFor("/tmp/wt-abc/", projects), "mono"); // trailing slash
  assert.equal(projectLabelFor("/Users/w/dev/mono", projects), "mono");
  assert.equal(projectLabelFor("/Users/w/dev/mono/packages/app", projects), "mono");
});

test("projectLabelFor: nested worktrees pick the longest match", () => {
  const projects = [
    { id: "outer", worktree: "/repo", sandboxes: [] },
    { id: "inner", worktree: "/repo/services/api", sandboxes: [] },
  ];
  assert.equal(projectLabelFor("/repo/services/api/src", projects), "api");
  assert.equal(projectLabelFor("/repo/services/web", projects), "repo");
  assert.equal(projectLabelFor("/repo-other", projects), "repo-other"); // not inside /repo
});

test("projectLabelFor falls back to directory basename outside projects", () => {
  assert.equal(projectLabelFor("/tmp/random-project", []), "random-project");
  assert.equal(projectLabelFor("/Users/wichard/ghq/x/y", []), "y");
});

test("projectLabelFor: no label for root/undefined dirs, root projects ignored", () => {
  assert.equal(projectLabelFor("/", [{ id: "g", worktree: "/" }]), "");
  assert.equal(projectLabelFor(undefined, []), "");
  assert.equal(projectLabelFor("/srv/app", [{ id: "g", worktree: "/" }]), "app");
});

test("projectLabelFor: aliases win and long labels are abbreviated", () => {
  const projects = [{ id: "p", worktree: "/repo/mono", sandboxes: ["/tmp/wt-1"] }];
  const aliases = new Map([["/repo/mono", "Mono"], ["/elsewhere/dir", "Else"]]);
  assert.equal(projectLabelFor("/tmp/wt-1", projects, aliases), "Mono");
  assert.equal(projectLabelFor("/elsewhere/dir", projects, aliases), "Else");
  assert.equal(projectLabelFor("/x/even-terminal-opencode", []), "even-terminal…");
  assert.equal(abbrevLabel("short"), "short");
  assert.equal(abbrevLabel("averyveryverylongname"), "averyveryvery…");
});

test("openchamber internal chat dirs get a 'chat' label, not the session UUID", () => {
  const dir = "/Users/wichard/.config/openchamber/chats/2026-09-15/session-ec285024-80ce-4d0a";
  assert.equal(projectLabelFor(dir, []), "chat");
  // outside the chats tree a session-* basename stays untouched
  assert.equal(projectLabelFor("/tmp/session-abc123", []), "session-abc123");
  // regular projects unaffected
  assert.equal(projectLabelFor("/tmp/wt-abc", [{ id: "p", worktree: "/Users/w/dev/mono", sandboxes: ["/tmp/wt-abc"] }]), "mono");
});
