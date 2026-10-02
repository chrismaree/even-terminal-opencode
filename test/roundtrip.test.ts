import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MessageHub } from "../src/hub.ts";
import { OpenChamberClient } from "../src/openchamber.ts";
import { createOpencodeProvider } from "../src/provider.ts";
import { createBridgeServer } from "../src/server.ts";

// ── stub OpenCode v2 API (as proxied by OpenChamber) ───

interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
}

interface Stub {
  url: string;
  requests: StubRequest[];
  /** Session.Info rows (v2 shape, `location.directory`) */
  setSessions(list: unknown[]): void;
  setActive(map: Record<string, { type: string }>): void;
  /** pending permissions, optionally only for one location directory */
  setPermissions(list: unknown[], directory?: string): void;
  /** pending forms, optionally only for one location directory */
  setForms(list: unknown[], directory?: string): void;
  setProjects(list: unknown[]): void;
  /** messages oldest-first; the stub serves them newest-first like v2 does */
  setMessages(list: unknown[]): void;
  pushEvent(type: string, data: Record<string, unknown>, directory?: string): void;
  close(): Promise<void>;
}

const DEFAULT_DIR = "/tmp/home";

function startStub(): Promise<Stub> {
  const requests: StubRequest[] = [];
  let sessions: unknown[] = [];
  let active: Record<string, { type: string }> = {};
  let permissions: { list: unknown[]; directory?: string } = { list: [] };
  let forms: { list: unknown[]; directory?: string } = { list: [] };
  let projectRows: unknown[] = [{ id: "p1", canonical: "/tmp/project", sandboxes: [] }];
  let messages: unknown[] = [];
  const sseClients = new Set<ServerResponse>();
  let eventSeq = 0;

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const method = req.method ?? "GET";
    const path = url.pathname;
    requests.push({ method, path, query: url.searchParams, headers: req.headers, body });
    const location = url.searchParams.get("location[directory]") ?? undefined;
    const scoped = (entry: { list: unknown[]; directory?: string }) =>
      !entry.directory || entry.directory === location ? entry.list : [];

    if (method === "GET" && path === "/api/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (method === "GET" && path === "/api/session") return send(res, { data: sessions, cursor: null });
    if (method === "POST" && path === "/api/session") {
      const b = (body ?? {}) as { title?: string; location?: { directory?: string } };
      return send(res, {
        data: {
          id: "ses_new1",
          title: b.title,
          location: { directory: b.location?.directory ?? DEFAULT_DIR },
          time: { created: 1, updated: 1 },
        },
      });
    }
    if (method === "GET" && path === "/api/session/active") return send(res, { data: active });
    if (method === "GET" && path === "/api/location") return send(res, { directory: DEFAULT_DIR, project: null });
    if (method === "GET" && path === "/api/project") return send(res, projectRows);
    if (method === "GET" && path === "/api/permission/request") {
      return send(res, { location: { directory: location ?? DEFAULT_DIR }, data: scoped(permissions) });
    }
    if (method === "GET" && path === "/api/form") {
      return send(res, { location: { directory: location ?? DEFAULT_DIR }, data: scoped(forms) });
    }
    const messageMatch = path.match(/^\/api\/session\/([^/]+)\/message$/);
    if (method === "GET" && messageMatch) return send(res, { data: messages.slice().reverse() });
    if (method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(path)) {
      return send(res, { data: { id: "msg_u", type: "user", text: (body as { text?: string })?.text } });
    }
    if (method === "POST" && /^\/api\/session\/[^/]+\/interrupt$/.test(path)) return send(res, { interrupted: true });
    if (method === "POST" && /^\/api\/session\/[^/]+\/(permission|form)\/[^/]+\/reply$/.test(path)) return noContent(res);
    if (method === "DELETE" && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(path)) return noContent(res);
    const sessionMatch = path.match(/^\/api\/session\/([^/]+)$/);
    if (method === "GET" && sessionMatch) {
      const row = sessions.find((s) => (s as { id: string }).id === sessionMatch[1]);
      if (row) return send(res, { data: row });
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: `stub: no route ${method} ${path}` }));
  }

  function send(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  function noContent(res: ServerResponse): void {
    res.writeHead(204);
    res.end();
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        setSessions: (l) => (sessions = l),
        setActive: (m) => (active = m),
        setPermissions: (list, directory) => (permissions = { list, directory }),
        setForms: (list, directory) => (forms = { list, directory }),
        setProjects: (l) => (projectRows = l),
        setMessages: (l) => (messages = l),
        pushEvent: (type, data, directory) => {
          const event = { id: `evt${++eventSeq}`, type, location: { directory: directory ?? "/tmp/project" }, data };
          for (const client of sseClients) client.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        close: () => {
          server.closeAllConnections();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

// ── rig ─────────────────────────────────────────────────

const TOKEN = "testtoken";

const SESSION_ROW = {
  id: "ses1",
  title: "Fix the bug",
  location: { directory: "/tmp/project" },
  time: { created: 1_699_999_000_000, updated: 1_700_000_000_000 },
};

interface Rig {
  bridgeUrl: string;
  stub: Stub;
  provider: ReturnType<typeof createOpencodeProvider>;
  bridgeLog: string[];
  providerLog: string[];
  close: () => Promise<void>;
}

async function startRig(
  opts: { sessions?: unknown[]; active?: Record<string, { type: string }>; authorization?: string } = {},
): Promise<Rig> {
  const stub = await startStub();
  stub.setSessions(opts.sessions ?? [SESSION_ROW]);
  stub.setActive(opts.active ?? {});
  const hub = new MessageHub();
  const oc = new OpenChamberClient(stub.url, { authorization: opts.authorization });
  const providerLog: string[] = [];
  const bridgeLog: string[] = [];
  const provider = createOpencodeProvider({
    oc,
    hub,
    eventUrl: `${stub.url}/api/event`,
    cacheTtlMs: 0,
    settingsPath: `/tmp/eto-test-missing-settings-${process.pid}.json`,
    log: (line) => providerLog.push(line),
  });
  const bridge = createBridgeServer({ provider, hub, token: TOKEN, log: (line) => bridgeLog.push(line) });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const addr = bridge.address() as { port: number };
  provider.start();
  await new Promise((r) => setTimeout(r, 80)); // let upstream connect + initial sync
  await provider.syncNow();
  return {
    bridgeUrl: `http://127.0.0.1:${addr.port}`,
    stub,
    provider,
    bridgeLog,
    providerLog,
    close: async () => {
      provider.stop();
      bridge.closeAllConnections();
      await new Promise((r) => bridge.close(() => r(undefined)));
      await stub.close();
    },
  };
}

type Msg = Record<string, unknown>;

/** Open a bridge SSE subscription; resolves once the stream is live. */
async function openSse(rig: Rig, sessionId: string, needReplay = true) {
  const controller = new AbortController();
  const res = await fetch(
    `${rig.bridgeUrl}/api/events?sessionId=${sessionId}&needReplay=${needReplay}&token=${TOKEN}`,
    { signal: controller.signal },
  );
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Msg[] = [];
  let buffer = "";

  /** Read until predicate matches (or timeout); returns everything seen so far. */
  async function until(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg[]> {
    const deadline = Date.now() + timeoutMs;
    while (!messages.some(pred)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining));
      const next = await Promise.race([reader.read(), timer]);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) messages.push(JSON.parse(line.slice(5).trim()) as Msg);
        }
      }
    }
    return messages;
  }

  return { messages, until, close: () => controller.abort() };
}

async function post(rig: Rig, path: string, body: unknown, token = TOKEN): Promise<{ status: number; json: Msg }> {
  const res = await fetch(`${rig.bridgeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Msg) : {} };
}

async function getJson(rig: Rig, path: string): Promise<{ status: number; json: Msg }> {
  const res = await fetch(`${rig.bridgeUrl}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, json: (await res.json()) as Msg };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const findReq = (rig: Rig, method: string, path: string) =>
  rig.stub.requests.find((r) => r.method === method && r.path === path);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── tests ───────────────────────────────────────────────

test("auth rejects requests without or with a wrong token", async () => {
  const rig = await startRig();
  try {
    assert.equal((await fetch(`${rig.bridgeUrl}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${rig.bridgeUrl}/api/sessions?token=wrong`)).status, 401);
    assert.equal(
      (await fetch(`${rig.bridgeUrl}/api/sessions`, { headers: { Authorization: "Bearer wrong" } })).status,
      401,
    );
    assert.equal((await post(rig, "/api/prompt", { sessionId: "ses1", text: "x" }, "wrong")).status, 401);
    assert.equal((await fetch(`${rig.bridgeUrl}/api/sessions?token=${TOKEN}`)).status, 200);
  } finally {
    await rig.close();
  }
});

test("bridge request log redacts the pairing token", async () => {
  const rig = await startRig();
  try {
    await fetch(`${rig.bridgeUrl}/api/sessions?provider=claude&token=${TOKEN}&limit=5`);
    const sse = await openSse(rig, "ses1");
    sse.close();
    await sleep(30);
    const logged = rig.bridgeLog.join("\n");
    assert.ok(rig.bridgeLog.some((l) => l.includes("GET /api/sessions?provider=claude&token=***&limit=5")), logged);
    assert.ok(rig.bridgeLog.some((l) => l.startsWith("SSE GET /api/events?") && l.includes("token=***")), logged);
    assert.ok(!logged.includes(TOKEN), `token leaked into log:\n${logged}`);
    assert.ok(!rig.providerLog.join("\n").includes(TOKEN));
  } finally {
    await rig.close();
  }
});

test("sessions listing maps v2 sessions with status and hides subagents", async () => {
  const rig = await startRig({
    sessions: [
      SESSION_ROW,
      { id: "sub", title: "subagent", parentID: "ses1", location: { directory: "/tmp/project" }, time: { updated: 2e12 } },
      { id: "ses2", title: "Idle one", location: { directory: "/tmp/project" }, time: { updated: 1_600_000_000_000 } },
    ],
    active: { ses1: { type: "running" } },
  });
  try {
    const { status, json } = await getJson(rig, "/api/sessions?provider=claude&limit=10");
    assert.equal(status, 200);
    const sessions = json.sessions as Array<{ id: string; status: string; provider: string; cwd: string; timestamp: string }>;
    assert.deepEqual(
      sessions.map((s) => s.id),
      ["ses1", "ses2"],
    );
    assert.equal(sessions[0]!.status, "busy"); // from /api/session/active
    assert.equal(sessions[1]!.status, "idle");
    assert.equal(sessions[0]!.provider, "claude");
    assert.equal(sessions[0]!.cwd, "/tmp/project"); // location.directory lifted
    assert.equal(sessions[0]!.timestamp, new Date(1_700_000_000_000).toISOString());

    // v2 list query: global, newest first, roots only
    const listReq = rig.stub.requests.find((r) => r.method === "GET" && r.path === "/api/session")!;
    assert.equal(listReq.query.get("order"), "desc");
    assert.equal(listReq.query.get("parentID"), "null");
    assert.ok(Number(listReq.query.get("limit")) > 0);

    // status endpoint agrees
    const st = await getJson(rig, "/api/status?sessionId=ses1");
    assert.deepEqual(st.json, { state: "busy", sessionId: "ses1", provider: "claude" });
    assert.equal((await getJson(rig, "/api/status?sessionId=nope")).status, 404);
  } finally {
    await rig.close();
  }
});

test("sessions list carries project, sandbox and chat labels", async () => {
  const rig = await startRig({
    sessions: [
      SESSION_ROW,
      { id: "wt", title: "Worktree task", location: { directory: "/tmp/wt/feature" }, time: { updated: 1_600_000_000_003 } },
      { id: "chat", title: "Quick question", location: { directory: DEFAULT_DIR }, time: { updated: 1_600_000_000_002 } },
      { id: "loose", title: "Elsewhere", location: { directory: "/srv/other-app" }, time: { updated: 1_600_000_000_001 } },
    ],
  });
  try {
    rig.stub.setProjects([
      { id: "p1", canonical: "/tmp/project", sandboxes: ["/tmp/wt/feature"] },
      { id: "global", canonical: DEFAULT_DIR, sandboxes: [] },
    ]);
    const { json } = await getJson(rig, "/api/sessions?provider=claude&limit=10");
    const titles = (json.sessions as Array<{ id: string; title: string }>).map((s) => [s.id, s.title]);
    assert.deepEqual(titles, [
      ["ses1", "project · Fix the bug"],
      ["wt", "project · Worktree task"],
      ["chat", "chat · Quick question"],
      ["loose", "other-app · Elsewhere"],
    ]);
  } finally {
    await rig.close();
  }
});

test("claude-sync provider alias is accepted, unknown providers rejected", async () => {
  const rig = await startRig();
  try {
    const res = await getJson(rig, "/api/sessions?provider=claude-sync&limit=5");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.sessions));
    assert.equal((await getJson(rig, "/api/sessions?provider=opencode")).status, 200);
    assert.equal((await getJson(rig, "/api/sessions?provider=codex")).status, 400);
  } finally {
    await rig.close();
  }
});

test("even-app flow: prompt -> user_prompt + busy, text deltas, idle -> result", async () => {
  const rig = await startRig();
  try {
    rig.stub.setMessages([
      { id: "m0", type: "assistant", content: [{ type: "text", text: "old answer" }], cost: 5, tokens: { input: 999, output: 999 } },
      { id: "m1", type: "user", text: "do the thing" },
      {
        id: "m2",
        type: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool", id: "t1", name: "shell", state: { status: "completed", input: { command: "ls" } } },
        ],
        cost: 0.01,
        tokens: { input: 100, output: 10 },
      },
      { id: "m3", type: "assistant", content: [{ type: "text", text: "all done" }], cost: 0.02, tokens: { input: 200, output: 20 } },
    ]);
    const sse = await openSse(rig, "ses1");

    const promptRes = await post(rig, "/api/prompt", { sessionId: "ses1", text: "do the thing" });
    assert.equal(promptRes.status, 202);
    assert.deepEqual(promptRes.json, { ok: true, sessionId: "ses1", provider: "claude" });

    // bridge -> v2 prompt endpoint
    const promptCall = findReq(rig, "POST", "/api/session/ses1/prompt");
    assert.ok(promptCall, "expected POST /api/session/ses1/prompt");
    assert.deepEqual(promptCall.body, { text: "do the thing" });

    // upstream v2 stream -> deltas
    rig.stub.pushEvent("session.execution.started", { sessionID: "ses1" });
    rig.stub.pushEvent("session.reasoning.started", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 0 });
    rig.stub.pushEvent("session.reasoning.delta", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 0, delta: "secret" });
    rig.stub.pushEvent("session.reasoning.ended", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 0, text: "secret" });
    rig.stub.pushEvent("session.text.started", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 1 });
    rig.stub.pushEvent("session.text.delta", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 1, delta: "all" });
    rig.stub.pushEvent("session.text.delta", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 1, delta: " done" });
    rig.stub.pushEvent("session.text.ended", { sessionID: "ses1", assistantMessageID: "a1", ordinal: 1, text: "all done" });
    rig.stub.pushEvent("session.execution.succeeded", { sessionID: "ses1" });
    // a trailing session.idle must not produce a second result
    rig.stub.pushEvent("session.idle", { sessionID: "ses1" });

    const messages = await sse.until((m) => m.type === "result");
    await sleep(100);
    await sse.until(() => false, 50);
    sse.close();

    const kinds = messages.map((m) => (m.type === "status" ? `status:${m.state as string}` : (m.type as string)));
    const at = (k: string) => kinds.indexOf(k);
    assert.ok(at("user_prompt") !== -1, `missing user_prompt in ${kinds.join(",")}`);
    assert.ok(at("user_prompt") < at("status:busy"));
    assert.ok(at("status:busy") < at("status:think_start"));
    assert.ok(at("status:think_start") < at("status:think_end"));
    assert.ok(at("status:think_end") < at("status:text_start"));
    assert.ok(at("status:text_start") < at("text_delta"));
    assert.ok(at("text_delta") < at("status:text_end"));
    assert.ok(at("status:text_end") < at("result"));

    const text = messages
      .filter((m) => m.type === "text_delta")
      .map((m) => m.text as string)
      .join("");
    assert.equal(text, "all done"); // reasoning never leaks, text.ended adds nothing new
    assert.ok(!JSON.stringify(messages).includes("secret"));

    const results = messages.filter((m) => m.type === "result");
    assert.equal(results.length, 1, `expected one result in ${kinds.join(",")}`);
    const result = results[0]!;
    assert.equal(result.success, true);
    assert.equal(result.text, "all done");
    assert.equal(result.sessionId, "ses1");
    assert.equal(result.provider, "claude");
    assert.equal(result.turns, 2); // two assistant steps since the user message
    assert.equal(result.inputTokens, 300);
    assert.equal(result.outputTokens, 30);
    assert.ok(Math.abs((result.costUsd as number) - 0.03) < 1e-9);

    const msgReq = rig.stub.requests.find((r) => r.path === "/api/session/ses1/message")!;
    assert.equal(msgReq.query.get("order"), "desc");

    // idle again after the turn
    assert.equal((await getJson(rig, "/api/status?sessionId=ses1")).json.state, "idle");
  } finally {
    await rig.close();
  }
});

test("execution.failed surfaces an error card before the turn ends", async () => {
  const rig = await startRig();
  try {
    rig.stub.setMessages([{ id: "m1", type: "user", text: "go" }]);
    const sse = await openSse(rig, "ses1");
    rig.stub.pushEvent("session.execution.started", { sessionID: "ses1" });
    rig.stub.pushEvent("session.retry.scheduled", { sessionID: "ses1", attempt: 1, error: { message: "overloaded" } });
    rig.stub.pushEvent("session.execution.failed", { sessionID: "ses1", error: { message: "model exploded" } });
    const messages = await sse.until((m) => m.type === "result");
    sse.close();
    const retry = messages.find((m) => m.type === "notification" && m.title === "Retrying");
    assert.ok(retry, "expected retry notification");
    assert.equal(retry.message, "Retrying (attempt 1)… overloaded");
    const errIdx = messages.findIndex((m) => m.type === "error");
    assert.ok(errIdx !== -1, "expected error card");
    assert.equal(messages[errIdx]!.message, "model exploded");
    assert.ok(errIdx < messages.findIndex((m) => m.type === "result"));
  } finally {
    await rig.close();
  }
});

test("tool events render quiet summaries on the glasses", async () => {
  const rig = await startRig();
  try {
    const sse = await openSse(rig, "ses1");
    const tool = (id: string, name: string, input: Record<string, unknown>) => {
      rig.stub.pushEvent("session.tool.input.started", { sessionID: "ses1", assistantMessageID: "a", id, name });
      rig.stub.pushEvent("session.tool.called", { sessionID: "ses1", assistantMessageID: "a", id, input });
      rig.stub.pushEvent("session.tool.success", { sessionID: "ses1", assistantMessageID: "a", id, content: [{ type: "text", text: "ok" }] });
    };
    tool("t1", "read", { path: "/tmp/project/a.ts" });
    tool("t2", "shell", { command: "npm test" });
    const messages = await sse.until((m) => m.type === "tool_end");
    sse.close();
    const tools = messages.filter((m) => m.type === "tool_start" || m.type === "tool_end");
    assert.deepEqual(tools, [
      { type: "tool_start", name: "shell", toolId: "t2" },
      { type: "tool_end", name: "shell", toolId: "t2", summary: "npm test" },
    ]);
  } finally {
    await rig.close();
  }
});

test("permission-response routes ring decisions to the v2 reply endpoint", async () => {
  const rig = await startRig();
  try {
    // pending permission discovered by the REST snapshot -> permission_request
    rig.stub.setPermissions([{ id: "req1", sessionID: "ses1", action: "shell", resources: ["rm -rf build"] }]);
    await rig.provider.syncNow();
    const sse = await openSse(rig, "ses1");
    const seen = await sse.until((m) => m.type === "permission_request");
    const request = seen.find((m) => m.type === "permission_request");
    assert.ok(request, "expected permission_request broadcast");
    assert.equal(request.toolName, "shell");
    assert.equal(request.toolUseId, "req1");
    assert.equal(request.description, "shell: rm -rf build");
    assert.equal(seen.filter((m) => m.type === "permission_request").length, 1); // deduped across locations

    // awaiting while the ask is pending
    assert.equal((await getJson(rig, "/api/status?sessionId=ses1")).json.state, "awaiting");

    // pending permissions are polled per known session location
    assert.ok(
      rig.stub.requests.some(
        (r) => r.path === "/api/permission/request" && r.query.get("location[directory]") === "/tmp/project",
      ),
    );

    // ring tap "allow" -> POST /api/permission-response -> v2 reply
    const reply = await post(rig, "/api/permission-response", { sessionId: "ses1", decision: "allow" });
    assert.equal(reply.status, 200);
    const replyCall = await waitFor(() => findReq(rig, "POST", "/api/session/ses1/permission/req1/reply"));
    assert.deepEqual(replyCall.body, { decision: "once" });
    rig.stub.setPermissions([]); // answered upstream

    const result = (await sse.until((m) => m.type === "permission_result")).find((m) => m.type === "permission_result");
    assert.ok(result, "expected permission_result broadcast");
    assert.equal(result.decision, "allowed");
    assert.equal(result.toolName, "shell");

    // event-driven ask + "allowAlways" -> decision "always"
    rig.stub.pushEvent("permission.asked", { id: "req2", sessionID: "ses1", action: "edit", resources: ["src/a.ts"] });
    await sse.until((m) => m.type === "permission_request" && m.toolUseId === "req2");
    await post(rig, "/api/permission-response", { sessionId: "ses1", decision: "allowAlways" });
    const always = await waitFor(() => findReq(rig, "POST", "/api/session/ses1/permission/req2/reply"));
    assert.deepEqual(always.body, { decision: "always" });

    // "deny" (and anything unknown) -> reject
    rig.stub.pushEvent("permission.asked", { id: "req3", sessionID: "ses1", action: "shell", resources: ["curl x"] });
    await sse.until((m) => m.type === "permission_request" && m.toolUseId === "req3");
    await post(rig, "/api/permission-response", { sessionId: "ses1", decision: "bogus" });
    const reject = await waitFor(() => findReq(rig, "POST", "/api/session/ses1/permission/req3/reply"));
    assert.deepEqual(reject.body, { decision: "reject" });
    sse.close();
  } finally {
    await rig.close();
  }
});

test("permission answered elsewhere clears the ask and notifies", async () => {
  const rig = await startRig();
  try {
    const sse = await openSse(rig, "ses1");
    rig.stub.pushEvent("permission.asked", { id: "req9", sessionID: "ses1", action: "shell", resources: ["ls"] });
    await sse.until((m) => m.type === "permission_request");
    rig.stub.pushEvent("permission.replied", { sessionID: "ses1", requestID: "req9", reply: "once" });
    const seen = await sse.until((m) => m.type === "notification" && m.message === "Permission handled outside the glasses");
    sse.close();
    assert.ok(seen.some((m) => m.message === "Permission handled outside the glasses"));
    assert.equal((await getJson(rig, "/api/status?sessionId=ses1")).json.state, "idle");
    // a late ring reply is a no-op upstream
    await post(rig, "/api/permission-response", { sessionId: "ses1", decision: "allow" });
    await sleep(50);
    assert.equal(findReq(rig, "POST", "/api/session/ses1/permission/req9/reply"), undefined);
  } finally {
    await rig.close();
  }
});

test("question lifecycle: form.created -> user_question, label answer -> option value, skip -> cancel", async () => {
  const rig = await startRig();
  try {
    const sse = await openSse(rig, "ses1");
    rig.stub.pushEvent("form.created", {
      form: {
        id: "form1",
        sessionID: "ses1",
        title: "Choice",
        fields: [
          {
            key: "db",
            type: "select",
            title: "Which DB?",
            options: [
              { value: "sqlite", label: "SQLite", description: "embedded" },
              { value: "pg", label: "Postgres", description: "server" },
            ],
          },
        ],
      },
    });
    const seen = await sse.until((m) => m.type === "user_question");
    const q = seen.find((m) => m.type === "user_question") as
      | { questions: Array<{ question: string; options: Array<{ label: string }> }>; toolUseId: string }
      | undefined;
    assert.ok(q, "expected user_question broadcast");
    assert.equal(q.questions[0]!.question, "Which DB?");
    assert.deepEqual(
      q.questions[0]!.options.map((o) => o.label),
      ["SQLite", "Postgres"],
    );
    assert.equal(q.toolUseId, "form1");
    const hint = seen.find((m) => m.type === "notification" && m.title === "Agent asks");
    assert.equal(hint?.message, "Which DB?");
    assert.equal((await getJson(rig, "/api/status?sessionId=ses1")).json.state, "awaiting");

    // answer via the Even app (label) -> form reply keyed by field with the option value
    const reply = await post(rig, "/api/question-response", { sessionId: "ses1", answer: "SQLite" });
    assert.equal(reply.status, 200);
    const replyCall = await waitFor(() => findReq(rig, "POST", "/api/session/ses1/form/form1/reply"));
    assert.deepEqual(replyCall.body, { answer: { db: "sqlite" } });
    const answer = (await sse.until((m) => m.type === "question_answer")).find((m) => m.type === "question_answer");
    assert.deepEqual(answer?.answers, { "Which DB?": "SQLite" });

    // second question skipped -> DELETE (cancel)
    rig.stub.pushEvent("form.created", {
      form: { id: "form2", sessionID: "ses1", title: "Name?", fields: [{ key: "name", type: "text" }] },
    });
    await sse.until((m) => m.type === "user_question" && m.toolUseId === "form2");
    await post(rig, "/api/question-response", { sessionId: "ses1", answer: "skip" });
    await waitFor(() => findReq(rig, "DELETE", "/api/session/ses1/form/form2"));
    assert.equal(findReq(rig, "POST", "/api/session/ses1/form/form2/reply"), undefined);

    // answered elsewhere -> cleared with a notification
    rig.stub.pushEvent("form.created", {
      form: { id: "form3", sessionID: "ses1", title: "Again?", fields: [{ key: "ok", type: "boolean", title: "Again?" }] },
    });
    await sse.until((m) => m.type === "user_question" && m.toolUseId === "form3");
    rig.stub.pushEvent("form.replied", { id: "form3", sessionID: "ses1" });
    await sse.until((m) => m.type === "notification" && m.message === "Question answered elsewhere");
    sse.close();
    assert.equal((await getJson(rig, "/api/status?sessionId=ses1")).json.state, "idle");
  } finally {
    await rig.close();
  }
});

test("pending forms in other locations are discovered and answerable", async () => {
  const rig = await startRig({
    sessions: [
      SESSION_ROW,
      { id: "ses_proj2", title: "Worktree task", location: { directory: "/tmp/project2" }, time: { updated: 1_700_000_000_001 } },
    ],
  });
  try {
    // the form is only visible when polling that session's location
    rig.stub.setForms(
      [{ id: "fo_1", sessionID: "ses_proj2", title: "Go?", fields: [{ key: "go", type: "boolean", title: "Go?" }] }],
      "/tmp/project2",
    );
    await rig.provider.syncNow();
    const status = await getJson(rig, "/api/status?sessionId=ses_proj2");
    assert.equal(status.status, 200, "project-directory session must be statusable");
    assert.equal(status.json.state, "awaiting");

    const reply = await post(rig, "/api/question-response", { sessionId: "ses_proj2", answer: "Yes" });
    assert.equal(reply.status, 200);
    const replyCall = await waitFor(() => findReq(rig, "POST", "/api/session/ses_proj2/form/fo_1/reply"));
    assert.deepEqual(replyCall.body, { answer: { go: true } });
  } finally {
    await rig.close();
  }
});

test("interrupt routes to the v2 interrupt endpoint and marks idle without a result", async () => {
  const rig = await startRig({ active: { ses1: { type: "running" } } });
  try {
    const sse = await openSse(rig, "ses1", false);
    const res = await post(rig, "/api/interrupt", { sessionId: "ses1" });
    assert.equal(res.status, 200);
    await waitFor(() => findReq(rig, "POST", "/api/session/ses1/interrupt"));
    rig.stub.pushEvent("session.execution.interrupted", { sessionID: "ses1" });
    const seen = await sse.until(() => false, 300);
    sse.close();
    assert.ok(seen.some((m) => m.type === "status" && m.state === "idle"));
    assert.ok(!seen.some((m) => m.type === "result"), "interrupt must not add a result card");
    assert.equal(findReq(rig, "GET", "/api/session/ses1/message"), undefined);

    // unknown session -> 404, missing id -> 400
    assert.equal((await post(rig, "/api/interrupt", { sessionId: "nope" })).status, 404);
    assert.equal((await post(rig, "/api/interrupt", {})).status, 400);
  } finally {
    await rig.close();
  }
});

test("prompt without text is rejected", async () => {
  const rig = await startRig();
  try {
    const res = await post(rig, "/api/prompt", { sessionId: "ses1" });
    assert.equal(res.status, 400);
    assert.equal(findReq(rig, "POST", "/api/session/ses1/prompt"), undefined);
  } finally {
    await rig.close();
  }
});

test("new session from the glasses: prompt without sessionId creates one", async () => {
  const rig = await startRig();
  try {
    const res = await post(rig, "/api/prompt", { text: "hello   from\nthe ring" });
    assert.equal(res.status, 202);
    assert.equal(res.json.sessionId, "ses_new1");
    const create = findReq(rig, "POST", "/api/session");
    assert.ok(create, "expected session create request");
    // no cwd and no pinned dir -> server default location
    assert.deepEqual(create.body, { title: "hello from the ring" });
    const promptCall = findReq(rig, "POST", "/api/session/ses_new1/prompt");
    assert.ok(promptCall, "expected prompt on the new session");
    assert.deepEqual(promptCall.body, { text: "hello   from\nthe ring" });
    // the new session is immediately known to the bridge
    assert.equal((await getJson(rig, "/api/status?sessionId=ses_new1")).status, 200);

    // an explicit cwd becomes the v2 location
    await post(rig, "/api/prompt", { text: "in a project", cwd: "/tmp/project" });
    const creates = rig.stub.requests.filter((r) => r.method === "POST" && r.path === "/api/session");
    assert.deepEqual(creates[1]!.body, { title: "in a project", location: { directory: "/tmp/project" } });
  } finally {
    await rig.close();
  }
});

test("history rows come from v2 messages", async () => {
  const rig = await startRig();
  try {
    rig.stub.setMessages([
      { id: "m1", type: "user", text: "hi" },
      {
        id: "m2",
        type: "assistant",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "tool", id: "t1", name: "edit", state: { status: "completed", input: { path: "/x/app.ts" } } },
          { type: "text", text: "done" },
        ],
      },
    ]);
    const { status, json } = await getJson(rig, "/api/sessions/ses1/history?limit=10");
    assert.equal(status, 200);
    assert.deepEqual(json.history, [
      { role: "user", text: "you: hi" },
      { role: "tool", text: "> edit: app.ts" },
      { role: "assistant", text: "done" },
    ]);
  } finally {
    await rig.close();
  }
});

test("basic auth is sent on REST calls and the event stream", async () => {
  const authorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
  const rig = await startRig({ authorization });
  try {
    await post(rig, "/api/prompt", { sessionId: "ses1", text: "x" });
    const eventReq = rig.stub.requests.find((r) => r.path === "/api/event");
    assert.ok(eventReq, "expected the event stream to be opened");
    assert.equal(eventReq.headers.authorization, authorization);
    assert.equal(eventReq.headers.accept, "text/event-stream");
    for (const path of ["/api/session", "/api/session/active", "/api/session/ses1/prompt"]) {
      const req = rig.stub.requests.find((r) => r.path === path);
      assert.ok(req, `expected ${path}`);
      assert.equal(req.headers.authorization, authorization, path);
    }
  } finally {
    await rig.close();
  }
});
