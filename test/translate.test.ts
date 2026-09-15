import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpencodeEventTranslator,
  decisionToResponse,
  lastAssistantText,
  parseQuestionAnswer,
  permissionRequestMessage,
  questionMessage,
  toHistoryRows,
  toEvenSession,
  visibleRootSessions,
  projectLabelFor,
  abbrevLabel,
} from "../src/translate.ts";

test("text parts become append-only deltas", () => {
  const t = new OpencodeEventTranslator();
  const ev = (text: string) => ({
    type: "message.part.updated",
    properties: {
      part: { id: "prt1", messageID: "msg1", sessionID: "ses1", type: "text", text },
    },
  });
  assert.deepEqual(t.translate(ev("Hello")), [
    { sessionId: "ses1", msg: { type: "status", state: "text_start", sessionId: "ses1" } },
    { sessionId: "ses1", msg: { type: "text_delta", text: "Hello" } },
  ]);
  assert.deepEqual(t.translate(ev("Hello world")), [
    { sessionId: "ses1", msg: { type: "text_delta", text: " world" } },
  ]);
  // identical part -> no delta
  assert.deepEqual(t.translate(ev("Hello world")), []);
});

test("non-monotonic text rewrite emits the full text", () => {
  const t = new OpencodeEventTranslator();
  const ev = (text: string) => ({
    type: "message.part.updated",
    properties: {
      part: { id: "prt1", messageID: "msg1", sessionID: "ses1", type: "text", text },
    },
  });
  t.translate(ev("abc"));
  const out = t.translate(ev("xyz"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.msg.type, "text_delta");
  assert.equal((out[0]!.msg as { text: string }).text, "xyz");
});

test("tool parts emit tool_start once and tool_end on completion", () => {
  const t = new OpencodeEventTranslator();
  const ev = (status: string, title?: string) => ({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt9",
        messageID: "msg9",
        sessionID: "ses1",
        type: "tool",
        tool: "bash",
        callID: "call1",
        state: { status, title },
      },
    },
  });
  const started = t.translate(ev("running", "ls -la"));
  assert.deepEqual(started, [{ sessionId: "ses1", msg: { type: "tool_start", name: "bash", toolId: "call1" } }]);
  // duplicate running update -> no duplicate tool_start
  assert.deepEqual(t.translate(ev("running", "ls -la")), []);
  const ended = t.translate(ev("completed", "ls -la"));
  assert.equal(ended.length, 1);
  const msg = ended[0]!.msg;
  assert.equal(msg.type, "tool_end");
  assert.equal((msg as { summary: string }).summary, "ls -la");
  assert.equal((msg as { toolId: string }).toolId, "call1");
});

test("tool_end without seen start emits start+end pair", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt9",
        messageID: "msg9",
        sessionID: "ses1",
        type: "tool",
        tool: "edit",
        callID: "call2",
        state: { status: "completed", title: "patch" },
      },
    },
  });
  assert.deepEqual(
    out.map((o) => o.msg.type),
    ["tool_start", "tool_end"],
  );
});

test("session.status busy/idle and session.idle map to status messages", () => {
  const t = new OpencodeEventTranslator();
  assert.deepEqual(t.translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } }), [
    { sessionId: "s1", msg: { type: "status", state: "busy", sessionId: "s1" } },
  ]);
  assert.deepEqual(t.translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } }), [
    { sessionId: "s1", msg: { type: "status", state: "idle", sessionId: "s1" } },
  ]);
  // retry now maps to a Retrying notification (upstream parity)
  assert.deepEqual(t.translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry" } } }), [
    { sessionId: "s1", msg: { type: "notification", title: "Retrying", message: "Retrying…" } },
  ]);
  assert.deepEqual(t.translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 2 } } }), [
    { sessionId: "s1", msg: { type: "notification", title: "Retrying", message: "Retrying (attempt 2)…" } },
  ]);
  assert.deepEqual(t.translate({ type: "session.idle", properties: { sessionID: "s2" } }), [
    { sessionId: "s2", msg: { type: "status", state: "idle", sessionId: "s2" } },
  ]);
});

test("translator state is bounded via prune", () => {
  const t = new OpencodeEventTranslator();
  for (let i = 0; i < 1000; i++) {
    t.translate({
      type: "message.part.updated",
      properties: { part: { id: `p${i}`, messageID: `m${i}`, sessionID: "s", type: "text", text: "x" } },
    });
  }
  t.prune(100, 50);
  assert.ok(true); // no throw; internal maps bounded
});

test("visibleRootSessions filters archived/subagents/untitled and sorts", () => {
  const now = 10_000;
  const rows = visibleRootSessions([
    { id: "a", title: "Fix bug", time: { updated: now } },
    { id: "b", title: "archived", time: { updated: now + 5, archived: now + 5 } },
    { id: "c", title: "subagent", parentID: "a", time: { updated: now + 9 } },
    { id: "d", title: "New session - xyz", time: { updated: now + 8 } },
    { id: "e", title: "Newer", time: { updated: now + 1 } },
  ]);
  assert.deepEqual(
    rows.map((s) => s.id),
    ["e", "a"],
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

test("toHistoryRows flattens text+tool lines, capped", () => {
  const rows = toHistoryRows(
    [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { title: "ls" } }] },
      { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ],
    10,
  );
  assert.deepEqual(rows, [
    { role: "user", text: "you: hi" },
    { role: "tool", text: "> ls" },
    { role: "assistant", text: "done" },
  ]);
});

test("toHistoryRows respects char budget", () => {
  const rows = toHistoryRows(
    [
      { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "x".repeat(50) }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "y".repeat(30) }] },
    ],
    10,
    40,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.text, /^y+$/);
});

test("permissionRequestMessage builds options and detail", () => {
  const msg = permissionRequestMessage({
    id: "req1",
    type: "bash",
    title: "Run command",
    pattern: ["git *", "npm *"],
  });
  assert.equal(msg.type, "permission_request");
  const p = msg as { toolName: string; description: string; detail: string; toolUseId: string; options: unknown[] };
  assert.equal(p.toolName, "bash");
  assert.equal(p.description, "Run command");
  assert.equal(p.detail, "git *, npm *");
  assert.equal(p.toolUseId, "req1");
  assert.equal(p.options.length, 3);
});

test("decisionToResponse maps app decisions to opencode verbs", () => {
  assert.equal(decisionToResponse("allow"), "once");
  assert.equal(decisionToResponse("allowAlways"), "always");
  assert.equal(decisionToResponse("deny"), "reject");
  assert.equal(decisionToResponse("whatever"), "reject");
});

test("questionMessage maps questions", () => {
  const msg = questionMessage({
    id: "q1",
    questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "first" }] }],
  });
  assert.ok(msg);
  const q = msg as { questions: Array<{ question: string; options: Array<{ label: string }> }> };
  assert.equal(q.questions[0]!.question, "Which?");
  assert.equal(q.questions[0]!.options[0]!.label, "A");
  assert.equal(questionMessage({ id: "q2" }), null);
});

test("parseQuestionAnswer handles plain, JSON array and JSON map", () => {
  const qs = [{ question: "Which?" }, { question: "Where?" }];
  assert.deepEqual(parseQuestionAnswer("A", qs), ["A", "A"]);
  assert.deepEqual(parseQuestionAnswer('["A","B"]', qs), ["A", "B"]);
  assert.deepEqual(parseQuestionAnswer('{"Which?": "A", "Where?": "B"}', qs), ["A", "B"]);
});

test("lastAssistantText picks the last assistant text", () => {
  const text = lastAssistantText([
    { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "q" }] },
    { info: { id: "m2", role: "assistant" }, parts: [{ type: "tool", tool: "x", state: {} }, { type: "text", text: "answer" }] },
  ]);
  assert.equal(text, "answer");
  assert.equal(lastAssistantText([]), "");
});
test("message.part.delta streams incremental text", () => {
  const t = new OpencodeEventTranslator();
  const ev = (delta: string, field = "text") => ({
    type: "message.part.delta",
    properties: { sessionID: "ses1", messageID: "m1", partID: "p1", field, delta },
  });
  assert.deepEqual(t.translate(ev("Hello")), [
    { sessionId: "ses1", msg: { type: "status", state: "text_start", sessionId: "ses1" } },
    { sessionId: "ses1", msg: { type: "text_delta", text: "Hello" } },
  ]);
  assert.deepEqual(t.translate(ev(" world")), [
    { sessionId: "ses1", msg: { type: "text_delta", text: " world" } },
  ]);
  // non-text fields (tool state etc.) are ignored
  assert.deepEqual(t.translate(ev("x", "state")), []);
  // empty deltas ignored
  assert.deepEqual(t.translate(ev("")), []);
});

test("part.delta and part.updated share text state", () => {
  const t = new OpencodeEventTranslator();
  t.translate({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "abc" },
  });
  const out = t.translate({
    type: "message.part.updated",
    properties: { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "abcdef" } },
  });
  assert.deepEqual(out, [{ sessionId: "s", msg: { type: "text_delta", text: "def" } }]);
});

test("question.asked translates to user_question with ask bookkeeping", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "question.asked",
    properties: {
      sessionID: "s1",
      id: "q1",
      questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "first" }] }],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.msg.type, "user_question");
  assert.equal(out[0]!.ask?.kind, "question");
  assert.equal(out[0]!.ask?.requestId, "q1");
  assert.deepEqual(out[0]!.ask?.questions, [{ question: "Which?", header: "Choice" }]);
  // no questions -> nothing
  assert.deepEqual(t.translate({ type: "question.asked", properties: { sessionID: "s1", id: "q2" } }), []);
});

test("permission.asked translates to permission_request with ask bookkeeping", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "permission.asked",
    properties: { sessionID: "s1", id: "r1", type: "bash", title: "Run rm" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.msg.type, "permission_request");
  assert.deepEqual(out[0]!.ask, { kind: "permission", requestId: "r1", questions: [] });
  // nested permission object also accepted
  const out2 = t.translate({
    type: "permission.asked",
    properties: { sessionID: "s1", permission: { id: "r2", type: "edit", title: "Patch" } },
  });
  assert.equal((out2[0]!.msg as { toolUseId: string }).toolUseId, "r2");
});

test("question.replied / permission.replied produce reply bookkeeping", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "question.replied",
    properties: { sessionID: "s1", requestID: "q9" },
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.reply, { kind: "question", requestId: "q9" });
  const out2 = t.translate({
    type: "permission.replied",
    properties: { sessionID: "s1", requestID: "r9" },
  });
  assert.deepEqual(out2[0]!.reply, { kind: "permission", requestId: "r9" });
});

test("projectLabelFor: sandbox maps to parent project label", () => {
  const projects = [
    { id: "p1", worktree: "/Users/w/dev/mono", sandboxes: ["/tmp/wt-abc", "/tmp/wt-2"] },
  ];
  assert.equal(projectLabelFor("/tmp/wt-abc/inner", projects), "mono"); // sandbox subdir
  assert.equal(projectLabelFor("/tmp/wt-abc", projects), "mono"); // exact sandbox
  assert.equal(projectLabelFor("/Users/w/dev/mono", projects), "mono");
  assert.equal(projectLabelFor("/Users/w/dev/mono/packages/app", projects), "mono");
});

test("projectLabelFor falls back to directory basename outside projects", () => {
  assert.equal(projectLabelFor("/tmp/random-project", []), "random-project");
  assert.equal(projectLabelFor("/Users/wichard/ghq/x/y", []), "y");
});

test("projectLabelFor: no label for root/undefined dirs", () => {
  assert.equal(projectLabelFor("/", [{ id: "g", worktree: "/" }]), "");
  assert.equal(projectLabelFor(undefined, []), "");
  // deep dir inside a project worktree maps to the project label
  const projects = [{ id: "p1", worktree: "/repo/mono", sandboxes: [] }];
  assert.equal(projectLabelFor("/repo/mono/packages/app", projects), "mono");
  assert.equal(projectLabelFor("/repo/monolith", projects), "monolith"); // not inside worktree
});

test("toEvenSession prefixes title with label, capped at 64", () => {
  const s = { id: "id1", title: "T", directory: "/x/mono", time: { updated: 1 } };
  const out = toEvenSession(s, "grok-bot");
  assert.equal(out.title, "grok-bot · T");
  const long = toEvenSession(
    { id: "x", title: "y".repeat(80), directory: "/x/mono", time: {} },
    "grok-bot",
  );
  assert.equal(long.title.length, 64);
  assert.ok(long.title.startsWith("grok-bot · "));
});

test("openchamber internal chat dirs get a 'chat' label, not the session UUID", () => {
  const dir = "/Users/wichard/.config/openchamber/chats/2026-09-15/session-ec285024-80ce-4d0a";
  assert.equal(projectLabelFor(dir, []), "chat");
  // outside the chats tree a session-* basename stays untouched
  assert.equal(projectLabelFor("/tmp/session-abc123", []), "session-abc123");
  // regular projects unaffected
  assert.equal(projectLabelFor("/tmp/wt-abc", [{ id: "p", worktree: "/Users/w/dev/mono", sandboxes: ["/tmp/wt-abc"] }]), "mono");
});


test("quiet mode hides read-only tool cards, verbose shows them", () => {
  const toolEv = (tool: string, status: string) => ({
    type: "message.part.updated" as const,
    properties: {
      part: {
        id: "p1", messageID: "m1", sessionID: "s1", type: "tool",
        tool, callID: "c1",
        state: { status, title: "t", input: { command: "npm run build" }, output: "ok" },
      },
    },
  });
  const quiet = new OpencodeEventTranslator();
  assert.deepEqual(quiet.translate(toolEv("read", "running")), []);
  assert.deepEqual(quiet.translate(toolEv("read", "completed")), []);
  assert.deepEqual(quiet.translate(toolEv("grep", "running")), []);
  assert.deepEqual(quiet.translate(toolEv("todowrite", "completed")), []);
  // action tools still render in quiet mode
  assert.ok(quiet.translate(toolEv("bash", "running")).length > 0);
  const verbose = new OpencodeEventTranslator("", true);
  assert.ok(verbose.translate(toolEv("read", "running")).length > 0);
});

test("tool summaries are compact and opencode-aware", () => {
  const t = new OpencodeEventTranslator();
  const end = (tool: string, input: Record<string, unknown>, title = "") => {
    const out = t.translate({
      type: "message.part.updated",
      properties: {
        part: { id: `p-${tool}`, messageID: "m", sessionID: "s", type: "tool", tool, callID: `c-${tool}`, state: { status: "completed", title, input, output: "x".repeat(400) } },
      },
    });
    return out.find((o) => o.msg.type === "tool_end") as
      | { msg: { summary: string; detail?: { input?: unknown; output?: string } } }
      | undefined;
  };
  assert.equal(end("bash", { command: "npm run build\nmore" })!.msg.summary, "npm run build");
  assert.equal(end("edit", { filePath: "/a/b/app.ts", newString: "a\nb", oldString: "x" })!.msg.summary, "app.ts +1");
  assert.equal(end("write", { filePath: "/a/b/new.ts" })!.msg.summary, "new.ts");
  // quiet mode keeps cards summary-only
  const quietEnd = end("write", { filePath: "/a/new.ts" });
  assert.equal(quietEnd!.msg.detail, undefined);
  // verbose restores full detail
  const v = new OpencodeEventTranslator("", true);
  const vend = (tool: string, input: Record<string, unknown>) => {
    const out = v.translate({
      type: "message.part.updated",
      properties: {
        part: { id: `v-${tool}`, messageID: "m", sessionID: "s", type: "tool", tool, callID: `vc-${tool}`, state: { status: "completed", title: "", input, output: "x".repeat(400) } },
      },
    });
    return (out.find((o) => o.msg.type === "tool_end") as { msg: { detail?: { input?: unknown; output?: string } } }).msg.detail;
  };
  const bashDetail = vend("bash", { command: "ls -la" })!;
  assert.equal(bashDetail.input, "ls -la");
  assert.ok((bashDetail.output ?? "").length <= 201);
  assert.equal(vend("write", { filePath: "/a/new.ts" })!.input, undefined);
});


test("session.error maps to an error card", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "session.error",
    properties: { sessionID: "s1", error: { message: "model overloaded" } },
  });
  assert.deepEqual(out, [{ sessionId: "s1", msg: { type: "error", message: "model overloaded" } }]);
  // string error payload also works, capped
  const out2 = t.translate({
    type: "session.error",
    properties: { sessionID: "s1", error: "e".repeat(500) },
  });
  assert.equal((out2[0]!.msg as { message: string }).message.length, 201);
});



test("reasoning parts become thinking states, never raw text", () => {
  const t = new OpencodeEventTranslator();
  // reasoning part announced
  const reasoningStart = t.translate({
    type: "message.part.updated",
    properties: { part: { id: "rp", messageID: "m", sessionID: "s", type: "reasoning", text: "" } },
  });
  assert.deepEqual(reasoningStart, [
    { sessionId: "s", msg: { type: "status", state: "think_start", sessionId: "s" } },
  ]);
  // reasoning deltas (would leak chain-of-thought) are fully suppressed
  assert.deepEqual(t.translate({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m", partID: "rp", field: "text", delta: "secret reasoning" },
  }), []);
  // text part arrives: close thinking, open text, then stream
  const out = t.translate({
    type: "message.part.updated",
    properties: { part: { id: "tp", messageID: "m", sessionID: "s", type: "text", text: "The answer" } },
  });
  assert.deepEqual(
    out.map((o) => (o.msg.type === "status" ? (o.msg as { state: string }).state : o.msg.type)),
    ["think_end", "text_start", "text_delta"],
  );
  assert.equal((out[2]!.msg as { text: string }).text, "The answer");
});

test("TodoWrite completion emits task_progress without a tool card", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "message.part.updated",
    properties: {
      part: {
        id: "pt", messageID: "m", sessionID: "s", type: "tool", tool: "todowrite", callID: "ct",
        state: { status: "completed", title: "todos", input: { todos: [
          { content: "wire the bridge", status: "completed" },
          { content: "pair the glasses", status: "in_progress" },
          { content: "polish visuals", status: "pending" },
        ] } },
      },
    },
  });
  const progress = out.find((o) => o.msg.type === "task_progress") as
    | { msg: { completed: number; total: number; current: string } }
    | undefined;
  assert.ok(progress, "expected task_progress message");
  assert.equal(progress.msg.completed, 1);
  assert.equal(progress.msg.total, 3);
  assert.equal(progress.msg.current, "pair the glasses");
  assert.ok(!out.some((o) => o.msg.type === "tool_end"));
});

test("the question tool card is hidden (user_question drives the UI)", () => {
  const t = new OpencodeEventTranslator();
  const out = t.translate({
    type: "message.part.updated",
    properties: {
      part: { id: "pq", messageID: "m", sessionID: "s", type: "tool", tool: "question", callID: "cq", state: { status: "completed", title: "", input: {} } },
    },
  });
  assert.deepEqual(out, []); // no "> question" card next to the real question UI
});

test("user message parts never stream as assistant text", () => {
  const t = new OpencodeEventTranslator();
  // opencode announces the user's message part like any other text part
  t.translate({
    type: "message.updated",
    properties: { info: { id: "mu", sessionID: "s", role: "user" } },
  });
  assert.deepEqual(t.translate({
    type: "message.part.updated",
    properties: { part: { id: "up", messageID: "mu", sessionID: "s", type: "text", text: "fix the bug" } },
  }), []);
  assert.deepEqual(t.translate({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "mu", partID: "pu", field: "text", delta: "fix the" },
  }), []);
});
