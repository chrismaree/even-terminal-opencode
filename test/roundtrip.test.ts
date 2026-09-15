import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MessageHub } from "../src/hub.ts";
import { OpenChamberClient } from "../src/openchamber.ts";
import { createOpencodeProvider } from "../src/provider.ts";

// ── stub OpenChamber ────────────────────────────────────

interface Stub {
  url: string;
  requests: Array<{ path: string; body: unknown }>;
  setSessions(list: unknown[]): void;
  setPermissions(list: unknown[]): void;
  setQuestions(list: unknown[]): void;
  setProjects(list: unknown[]): void;
  setProject2Sessions(list: unknown[]): void;
  createdSessions: Array<{ id: string }>;
  setMessages(list: unknown[]): void;
  pushEvent(payload: unknown): void;
  close(): Promise<void>;
  closeAllConnections(): void;
}

function startStub(): Promise<Stub> {
  const requests: Array<{ path: string; body: unknown }> = [];
  let sessions: unknown[] = [];
  let permissions: unknown[] = [];
  let questions: unknown[] = [];
  let projectRows: unknown[] = [{ id: "p1", worktree: "/tmp/project", sandboxes: [] }];
  let project2Sessions: unknown[] = [];
  let messages: unknown[] = [];
  const createdSessions: Array<{ id: string }> = [];
  const sseClients = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path: url.pathname, body });

    if (url.pathname === "/api/session" && req.method === "GET") {
      const dir = url.searchParams.get("directory");
      if (dir === "/tmp/project2") return send(res, project2Sessions);
      return send(res, sessions);
    }
    if (url.pathname === "/api/session-activity") return send(res, { ses1: { type: "busy" } });
    if (url.pathname === "/api/permission") return send(res, permissions);
    if (url.pathname === "/api/question") return send(res, questions);
    if (url.pathname === "/api/project") return send(res, projectRows);

    if (url.pathname === "/api/session/ses1/message") return send(res, messages);
    if (url.pathname === "/api/global/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (url.pathname === "/api/session" && req.method === "POST") {
      createdSessions.push({ id: "ses_new1" });
      return send(res, { id: "ses_new1", title: "New chat", directory: "/tmp/project" });
    }
    // capture reply routes, then ack
    send(res, { ok: true });
  }

  function send(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        setSessions: (l) => (sessions = l),
        setPermissions: (l) => (permissions = l),
        setQuestions: (l) => (questions = l),
        setProjects: (l) => (projectRows = l),
        setProject2Sessions: (l) => (project2Sessions = l),
        createdSessions,
        setMessages: (l) => (messages = l),
        pushEvent: (payload) => {
          for (const client of sseClients) client.write(`data: ${JSON.stringify({ payload })}\n\n`);
        },
        close: () => new Promise((r) => server.close(() => r())),
        closeAllConnections: () => server.closeAllConnections(),
      });
    });
  });
}

// ── rig ─────────────────────────────────────────────────

async function startRig(): Promise<{
  bridgeUrl: string;
  stub: Stub;
  provider: Awaited<ReturnType<typeof import("../src/provider.ts")["createOpencodeProvider"]>> & {
    syncNow: () => Promise<void>;
  };
  close: () => Promise<void>;
}> {
  const stub = await startStub();
  const hub = new MessageHub();
  const oc = new OpenChamberClient(stub.url);
  const provider = createOpencodeProvider({
    oc,
    hub,
    eventUrl: `${stub.url}/api/global/event`,
    mergeTtlMs: 50,
    registryPath: `/tmp/eto-test-registry-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  });
  const { createBridgeServer } = await import("../src/server.ts");
  const bridge = createBridgeServer({ provider, hub, token: "testtoken" });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const addr = bridge.address() as { port: number };
  provider.start();
  await new Promise((r) => setTimeout(r, 60)); // let upstream connect + sync
  return {
    bridgeUrl: `http://127.0.0.1:${addr.port}`,
    stub,
    provider: provider as typeof provider & { syncNow: () => Promise<void> },
    close: async () => {
      provider.stop();
      bridge.close();
      bridge.closeAllConnections();
      await stub.close();
      stub.closeAllConnections();
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

/** Collect bridge SSE messages until predicate matches or timeout. */
async function collectSse(
  url: string,
  opts: { until?: (msg: Record<string, unknown>) => boolean; max?: number; timeoutMs?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  try {
    while (messages.length < (opts.max ?? 100)) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          messages.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
        }
      }
      if (opts.until && messages.some(opts.until)) break;
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return messages;
}

async function post(
  url: string,
  body: unknown,
  token = "testtoken",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const TOKEN = "testtoken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const SESSION_ROW = {
  id: "ses1",
  title: "Fix the bug",
  directory: "/tmp/project",
  time: { updated: 1_700_000_000_000 },
};

// ── tests ───────────────────────────────────────────────

test("auth rejects requests without a token", async () => {
  const rig = await startRig();
  try {
    const res = await fetch(`${rig.bridgeUrl}/api/sessions`);
    assert.equal(res.status, 401);
  } finally {
    await rig.close();
  }
});

test("sessions listing maps opencode sessions with status", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW, { id: "sub", title: "subagent", parentID: "ses1" }]);
    const res = await fetch(`${rig.bridgeUrl}/api/sessions?token=${"testtoken"}&provider=claude&limit=10`);
    const body = (await res.json()) as { sessions: Array<{ id: string; status: string; provider: string }> };
    assert.equal(res.status, 200);
    assert.deepEqual(
      body.sessions.map((s) => s.id),
      ["ses1"],
    );
    assert.equal(body.sessions[0]!.status, "busy"); // from /api/session-activity
    assert.equal(body.sessions[0]!.provider, "claude");
  } finally {
    await rig.close();
  }
});

test("even-app flow: prompt streams user_prompt + busy, upstream deltas become text_delta, idle becomes result", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    rig.stub.setMessages([
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "do it" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "all done" }] },
    ]);
    await new Promise((r) => setTimeout(r, 60)); // allow syncSnapshot to learn sessions

    const ssePromise = collectSse(`${rig.bridgeUrl}/api/events?sessionId=ses1&needReplay=true&token=testtoken`, {
      until: (m) => m.type === "result",
      timeoutMs: 3000,
    });
    await new Promise((r) => setTimeout(r, 30));

    const promptRes = await post(`${rig.bridgeUrl}/api/prompt`, { sessionId: "ses1", text: "do the thing" });
    assert.equal(promptRes.status, 202);
    assert.equal(promptRes.json.ok, true);
    assert.equal(promptRes.json.sessionId, "ses1");

    // bridge -> OpenChamber used prompt_async
    const promptCall = rig.stub.requests.find((r) => r.path === "/api/session/ses1/prompt_async");
    assert.ok(promptCall);
    assert.deepEqual((promptCall.body as { parts: unknown }).parts, [{ type: "text", text: "do the thing" }]);

    // upstream stream -> deltas
    rig.stub.pushEvent({
      id: "e1",
      type: "message.part.updated",
      properties: { part: { id: "p1", messageID: "mm", sessionID: "ses1", type: "text", text: "hello" } },
    });
    rig.stub.pushEvent({
      id: "e2",
      type: "message.part.updated",
      properties: { part: { id: "p1", messageID: "mm", sessionID: "ses1", type: "text", text: "hello world" } },
    });
    rig.stub.pushEvent({ id: "e3", type: "session.status", properties: { sessionID: "ses1", status: { type: "idle" } } });

    const messages = await ssePromise;
    const types = messages.map((m) => m.type);
    assert.ok(types.includes("user_prompt"), `missing user_prompt in ${types.join(",")}`);
    assert.ok(types.includes("text_delta"), `missing text_delta in ${types.join(",")}`);
    assert.ok(types.includes("result"), `missing result in ${types.join(",")}`);
    const result = messages.find((m) => m.type === "result") as { text: string; success: boolean };
    assert.equal(result.success, true);
    assert.equal(result.text, "all done");
  } finally {
    await rig.close();
  }
});

test("permission-response routes ring decisions to OpenChamber reply", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    await new Promise((r) => setTimeout(r, 60));

    // pending permission arrives -> bridge broadcasts permission_request
    rig.stub.setPermissions([{ id: "req1", sessionID: "ses1", type: "bash", title: "Run rm" }]);
    await rig.provider.syncNow();
    const requestPhase = collectSse(`${rig.bridgeUrl}/api/events?sessionId=ses1&needReplay=true&token=testtoken`, {
      until: (m) => m.type === "permission_request",
      timeoutMs: 3000,
    });
    const request = ((await requestPhase).find((m) => m.type === "permission_request") ?? {}) as {
      toolName: string;
      toolUseId: string;
    };
    assert.ok(request.toolName, "expected permission_request broadcast");
    assert.equal(request.toolName, "bash");
    assert.equal(request.toolUseId, "req1");

    // ring tap "allow" -> POST /api/permission-response -> OpenChamber reply
    const resultPhase = collectSse(`${rig.bridgeUrl}/api/events?sessionId=ses1&needReplay=true&token=testtoken`, {
      until: (m) => m.type === "permission_result",
      timeoutMs: 3000,
    });
    await new Promise((r) => setTimeout(r, 30));
    const reply = await post(`${rig.bridgeUrl}/api/permission-response`, {
      sessionId: "ses1",
      decision: "allow",
    });
    assert.equal(reply.status, 200);
    await new Promise((r) => setTimeout(r, 50)); // reply POST is fire-and-forget
    const replyCall = rig.stub.requests.find((r) => r.path === "/api/session/ses1/permission/req1/reply");
    assert.ok(replyCall, "expected permission reply request");
    assert.deepEqual(replyCall.body, { response: "once" });

    const resultMsg = (await resultPhase).find((m) => m.type === "permission_result") as {
      decision: string;
    } | undefined;
    assert.ok(resultMsg, "expected permission_result broadcast");
    assert.equal(resultMsg.decision, "allowed");
  } finally {
    await rig.close();
  }
});

test("interrupt routes to OpenChamber and marks idle", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    await rig.provider.syncNow();
    const res = await post(`${rig.bridgeUrl}/api/interrupt`, { sessionId: "ses1" });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50)); // interrupt POST is fire-and-forget
    const interrupt = rig.stub.requests.find((r) => r.path === "/api/session/ses1/interrupt");
    assert.ok(interrupt, "expected interrupt request to OpenChamber");
    // unknown session -> 404
    const missing = await post(`${rig.bridgeUrl}/api/interrupt`, { sessionId: "nope" });
    assert.equal(missing.status, 404);
  } finally {
    await rig.close();
  }
});

test("prompt without text is rejected", async () => {
  const rig = await startRig();
  try {
    const res = await post(`${rig.bridgeUrl}/api/prompt`, { sessionId: "ses1" });
    assert.equal(res.status, 400);
  } finally {
    await rig.close();
  }
});

test("question lifecycle: asked event -> user_question, answer -> OpenChamber reply", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    await rig.provider.syncNow();

    rig.stub.pushEvent({
      id: "q-evt",
      type: "question.asked",
      properties: {
        sessionID: "ses1",
        id: "quest1",
        questions: [
          { question: "Which DB?", header: "Choice", options: [{ label: "SQLite", description: "embedded" }, { label: "Postgres", description: "server" }] },
        ],
      },
    });
    const phase = collectSse(`${rig.bridgeUrl}/api/events?sessionId=ses1&needReplay=true&token=testtoken`, {
      until: (m) => m.type === "user_question",
      timeoutMs: 3000,
    });
    const seen = await phase;
    const q = seen.find((m) => m.type === "user_question") as { questions: Array<{ question: string }>; toolUseId: string } | undefined;
    assert.ok(q, "expected user_question broadcast");
    assert.equal(q.questions[0]!.question, "Which DB?");
    assert.equal(q.toolUseId, "quest1");

    // answer via the Even app
    const reply = await post(`${rig.bridgeUrl}/api/question-response`, { sessionId: "ses1", answer: "SQLite" });
    assert.equal(reply.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const replyCall = rig.stub.requests.find((r) => r.path === "/api/session/ses1/question/quest1/reply");
    assert.ok(replyCall, "expected question reply request");
    assert.deepEqual(replyCall.body, { answers: ["SQLite"] });
  } finally {
    await rig.close();
  }
});

test("text streaming rides message.part.delta events", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    await rig.provider.syncNow();
    const phase = collectSse(`${rig.bridgeUrl}/api/events?sessionId=ses1&needReplay=true&token=testtoken`, {
      until: (m) => m.type === "text_delta" && (m as { text: string }).text.endsWith("world"),
      timeoutMs: 3000,
    });
    await new Promise((r) => setTimeout(r, 30));
    rig.stub.pushEvent({
      type: "message.part.delta",
      properties: { sessionID: "ses1", messageID: "mm", partID: "pp", field: "text", delta: "hello" },
    });
    rig.stub.pushEvent({
      type: "message.part.delta",
      properties: { sessionID: "ses1", messageID: "mm", partID: "pp", field: "text", delta: " world" },
    });
    const seen = await phase;
    const deltas = seen.filter((m) => m.type === "text_delta") as Array<{ text: string }>;
    assert.deepEqual(deltas.map((d) => d.text), ["hello", " world"]);
  } finally {
    await rig.close();
  }
});

test("sessions list carries project labels from /api/project", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    const res = await fetch(`${rig.bridgeUrl}/api/sessions?token=testtoken&provider=claude&limit=10`);
    const body = (await res.json()) as { sessions: Array<{ title: string }> };
    assert.equal(body.sessions[0]!.title, "project · Fix the bug");
  } finally {
    await rig.close();
  }
});


test("new session from the glasses: prompt without sessionId creates one", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    await rig.provider.syncNow();
    const res = await post(`${rig.bridgeUrl}/api/prompt`, { text: "hello from the ring" });
    assert.equal(res.status, 202);
    assert.equal(res.json.sessionId, "ses_new1");
    await new Promise((r) => setTimeout(r, 50));
    const promptCall = rig.stub.requests.find((r) => r.path === "/api/session/ses_new1/prompt_async");
    assert.ok(promptCall, "expected prompt_async on the new session");
    assert.ok(rig.stub.createdSessions.length > 0, "expected session create request");
  } finally {
    await rig.close();
  }
});


test("claude-sync provider alias is accepted (Terminal v2)", async () => {
  const rig = await startRig();
  try {
    rig.stub.setSessions([SESSION_ROW]);
    const res = await fetch(`${rig.bridgeUrl}/api/sessions?token=testtoken&provider=claude-sync&limit=5`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: unknown[] };
    assert.ok(Array.isArray(body.sessions));
  } finally {
    await rig.close();
  }
});

test("project-directory sessions are statusable and answerable (no 404 on ring replies)", async () => {
  const rig = await startRig();
  try {
    // a session that ONLY exists in a project-directory listing
    rig.stub.setSessions([]);
    rig.stub.setProjects([
      { id: "p1", worktree: "/tmp/project", sandboxes: [] },
      { id: "p2", worktree: "/tmp/project2", sandboxes: [] },
    ]);
    rig.stub.setProject2Sessions([
      { id: "ses_proj1", title: "Worktree task", directory: "/tmp/project2", time: { updated: 1_700_000_000_000 } },
    ]);
    await rig.provider.syncNow();
    const dirReqs = rig.stub.requests.filter((r) => r.path.includes("directory"));


    // statusable (this is exactly what 404'd before)
    const status = await fetch(`${rig.bridgeUrl}/api/status?sessionId=ses_proj1&token=testtoken`);
    assert.equal(status.status, 200, "project-directory session must be statusable");
    const statusBody = (await status.json()) as { state: string };
    assert.equal(statusBody.state, "idle");

    // answerable: pending question syncs from the snapshot, reply is routed
    rig.stub.setQuestions([
      { id: "qu_1", sessionID: "ses_proj1", questions: [{ question: "Go?", options: [{ label: "Yes" }] }] },
    ]);
    await rig.provider.syncNow();
    const reply = await post(`${rig.bridgeUrl}/api/question-response`, { sessionId: "ses_proj1", answer: "Yes" });
    assert.equal(reply.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const replyCall = rig.stub.requests.find((r) => r.path === "/api/session/ses_proj1/question/qu_1/reply");
    assert.ok(replyCall, "expected question reply request");
  } finally {
    await rig.close();
  }
});
