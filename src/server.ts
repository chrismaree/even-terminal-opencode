// Bridge HTTP server implementing even-terminal's /api + SSE contract
// (mirrors vendor/even-terminal/dist/routes/{core,events}.js).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EvenProvider, PermissionDecision } from "./types.ts";
import { MessageHub } from "./hub.ts";

export interface BridgeServerOptions {
  provider: EvenProvider;
  hub: MessageHub;
  token: string;
  /** request/diagnostic log sink (default console.log) */
  log?: (line: string) => void;
}

/** Request path for logs, with the pairing token redacted. */
function redactUrl(raw: string | undefined): string {
  return (raw ?? "").replace(/([?&]token=)[^&]*/g, "$1***");
}

const DECISIONS: ReadonlySet<string> = new Set(["allow", "allowAlways", "deny"]);

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createBridgeServer(opts: BridgeServerOptions): Server {
  const { provider, hub, token } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));

  return createServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    if (req.url?.includes("/api/events")) log(`SSE ${req.method} ${redactUrl(req.url)}`);
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      // SSE streams "finish" only on close; skip their completion noise
      if (req.url?.includes("/api/events")) return;
      log(`${res.statusCode} ${req.method} ${redactUrl(req.url)} ${durationMs.toFixed(1)}ms`);
    });
    void handle(req, res).catch((err: Error) => {
      log(`[bridge] ${req.method} ${redactUrl(req.url).split("?")[0]} failed: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // auth: Bearer header or ?token= (mirrors upstream)
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
    if (provided !== token) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    const providerName = url.searchParams.get("provider") ?? undefined;
    // We serve a single opencode-backed provider; accept the names the app may
    // offer (Terminal v2 added "claude-sync").
    if (
      providerName !== undefined &&
      providerName !== "claude" &&
      providerName !== "opencode" &&
      providerName !== "claude-sync"
    ) {
      json(res, 400, { error: `Unsupported provider "${providerName}". Supported providers: claude, opencode, claude-sync` });
      return;
    }

    // ── SSE ─────────────────────────────────────────────
    if (req.method === "GET" && path === "/api/events") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        json(res, 400, { error: "Missing 'sessionId' query parameter" });
        return;
      }
      const needReplay = url.searchParams.get("needReplay") === "true";
      hub.subscribe(sessionId, res, { needReplay });
      return;
    }

    // ── sessions & info ─────────────────────────────────
    if (req.method === "GET" && path === "/api/sessions") {
      // The app may not pass a limit (default 10 upstream); serve at least 25
      // so older worktree sessions stay reachable, capped to keep responses light.
      const requested = Number(url.searchParams.get("limit")) || 10;
      const limit = Math.min(Math.max(requested, 25), 50);
      const cwd = url.searchParams.get("cwd") ?? undefined;
      try {
        const sessions = await provider.listSessions(limit, cwd);
        // status for every session (in-memory; mirrors upstream's first-10
        // fill but keeps later rows useful too)
        await Promise.all(
          sessions.map(async (s) => {
            if (s.status) return;
            s.status = await provider.getSessionStatus(s.id);
          }),
        );
        json(res, 200, { sessions });
      } catch (err) {
        log(`[sessions] failed: ${(err as Error).message}`);
        json(res, 200, { sessions: [], error: (err as Error).message });
      }
      return;
    }

    if (req.method === "GET" && path === "/api/info") {
      try {
        json(res, 200, await provider.getInfo());
      } catch (err) {
        json(res, 200, { account: {}, model: "Unknown", version: "Unknown", error: (err as Error).message });
      }
      return;
    }

    if (req.method === "GET" && path === "/api/update-check") {
      json(res, 200, { version: "0.1.0", newestVersion: null, updateAvailable: false });
      return;
    }

    // ── session history / messages / status ─────────────
    const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      const id = decodeURIComponent(historyMatch[1]!);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 10);
      try {
        json(res, 200, { history: await provider.getHistory(id, limit) });
      } catch (err) {
        json(res, 200, { history: [], error: (err as Error).message });
      }
      return;
    }

    if (req.method === "GET" && path === "/api/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        json(res, 400, { error: "Missing 'sessionId'" });
        return;
      }
      const after = Number(url.searchParams.get("after")) || 0;
      const status = provider.getStatus(sessionId);
      json(res, 200, {
        messages: hub.getMessages(sessionId, after),
        state: status?.state ?? "idle",
        sessionId,
        provider: status?.provider ?? providerName ?? null,
      });
      return;
    }

    if (req.method === "GET" && path === "/api/status") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        json(res, 400, { error: "Missing 'sessionId'" });
        return;
      }
      const status = provider.getStatus(sessionId);
      if (!status) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      json(res, 200, { state: status.state, sessionId, provider: status.provider });
      return;
    }

    // ── actions ─────────────────────────────────────────
    if (req.method === "POST" && path === "/api/prompt") {
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!text) {
        json(res, 400, { error: "Missing 'text' field" });
        return;
      }
      try {
        const result = await provider.prompt(sessionId ?? "", text, cwd);
        json(res, 202, { ok: true, sessionId: result.sessionId, provider: result.provider });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        log(`[prompt] failed: ${(err as Error).message}`);
        json(res, status, { error: (err as Error).message });
      }
      return;
    }

    if (req.method === "POST" && path === "/api/permission-response") {
      const body = await readBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const decision = (typeof body.decision === "string" ? body.decision : "deny") as PermissionDecision;
      if (!sessionId) {
        json(res, 400, { error: "Missing 'sessionId'" });
        return;
      }
      if (!provider.getStatus(sessionId)) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      provider.respondPermission(sessionId, DECISIONS.has(decision) ? decision : "deny");
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/api/question-response") {
      const body = await readBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const answer = typeof body.answer === "string" ? body.answer : "skip";
      if (!sessionId) {
        json(res, 400, { error: "Missing 'sessionId'" });
        return;
      }
      if (!provider.getStatus(sessionId)) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      provider.respondQuestion(sessionId, answer);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/api/interrupt") {
      const body = await readBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        json(res, 400, { error: "Missing 'sessionId'" });
        return;
      }
      if (!provider.getStatus(sessionId)) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      provider.interrupt(sessionId);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && path === "/api/metrics") {
      json(res, 200, { codex: { subscribedSessions: [] } });
      return;
    }

    const debugMatch = path.match(/^\/api\/debug\/thread\/([^/]+)$/);
    if (req.method === "GET" && debugMatch) {
      const id = decodeURIComponent(debugMatch[1]!);
      try {
        json(res, 200, { sessionId: id, messages: await provider.getHistory(id, 50) });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
      return;
    }

    json(res, 404, { error: `Not found: ${req.method} ${path}` });
  }
}
