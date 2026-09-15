// OpenChamber local API client (:57123). Endpoints verified against the
// OpenChamber desktop app (v1.22) — see vendor/ README notes.

import { execFileSync } from "node:child_process";

export interface OcSession {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  parentID?: string | null;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  time?: { created?: number; updated?: number; archived?: number | null };
}

export interface OcMessage {
  info: { id: string; role: string; time?: { created?: number } };
  parts: Array<{
    type: string;
    text?: string;
    synthetic?: boolean;
    ignored?: boolean;
    tool?: string;
    callID?: string;
    state?: {
      status?: string;
      title?: string;
      input?: unknown;
      output?: string;
      metadata?: unknown;
    };
  }>;
}

/** Pending permission as served by GET /api/permission. */
export interface OcPermission {
  id: string;
  sessionID?: string;
  sessionId?: string;
  type?: string;
  title?: string;
  pattern?: string | string[];
  patterns?: string[];
  metadata?: { always?: string[] } & Record<string, unknown>;
  [key: string]: unknown;
}

/** Ask-user question as surfaced by opencode's question API. */
export interface OcQuestion {
  id: string;
  sessionID?: string;
  sessionId?: string;
  questions?: Array<{
    question?: string;
    header?: string;
    multiple?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
  [key: string]: unknown;
}

export interface OcSessionActivity {
  [sessionId: string]: { type: string };
}

const DEFAULT_TIMEOUT_MS = 8000;

export class OpenChamberClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(base: string, fetchImpl: typeof fetch = fetch) {
    this.base = base;
    this.fetchImpl = fetchImpl;
  }

  // ── direct opencode server access ─────────────────────
  // OpenChamber's local HTTP API has no reply routes (the desktop app
  // answers asks/permissions via internal IPC). The opencode server itself
  // exposes them with HTTP Basic auth (user "opencode", password from the
  // serve process env OPENCODE_SERVER_PASSWORD).

  private directBase = "";
  private directAuth = "";

  /** Find the opencode serve process: port from argv, password from env. */
  async resolveDirectServer(
    run: (cmd: string, args: string[]) => string = (cmd, args) =>
      execFileSync(cmd, args, { encoding: "utf8" }),
  ): Promise<boolean> {
    try {
      const pgrepOut = run("pgrep", ["-f", "opencode serve"]);
      for (const pid of pgrepOut.split("\n").filter(Boolean)) {
        const env = run("ps", ["eww", pid]);
        const port = env.match(/--port (\d+)/)?.[1];
        const password = env.match(/OPENCODE_SERVER_PASSWORD=([^\s]+)/)?.[1];
        if (port && password) {
          this.directBase = `http://127.0.0.1:${port}`;
          this.directAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
          return true;
        }
      }
    } catch {
      // ps/pgrep unavailable or no opencode serve process
    }
    return false;
  }

  private async directRequest<T>(path: string, body: unknown, directory?: string): Promise<T> {
    if (!this.directBase) {
      const ok = await this.resolveDirectServer();
      if (!ok) throw new Error("opencode server not discoverable");
    }
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    const res = await this.fetchImpl(`${this.directBase}${path}${qs}`, {
      method: "POST",
      headers: {
        Authorization: this.directAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      this.resetDirectServer();
      throw new Error(`opencode ${path} -> HTTP 401 (re-discovering)`);
    }
    if (!res.ok) throw new Error(`opencode ${path} -> HTTP ${res.status}`);
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Reply to an opencode question directly on the opencode server.
   * `answers` is one array of selected labels per question (multi-select).
   */
  replyQuestionDirect(requestId: string, answers: string[][], directory?: string): Promise<unknown> {
    return this.directRequest(`/question/${encodeURIComponent(requestId)}/reply`, { answers }, directory);
  }

  /** Reply to an opencode permission request directly (reply: once|always|reject). */
  replyPermissionDirect(requestId: string, reply: string, directory?: string): Promise<unknown> {
    return this.directRequest(`/permission/${encodeURIComponent(requestId)}/reply`, { reply }, directory);
  }

  /** Invalidate direct-server discovery (e.g. after a 401). */
  resetDirectServer(): void {
    this.directBase = "";
    this.directAuth = "";
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (!res.ok) {
        throw new Error(`OpenChamber ${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
      }
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) {
        throw new Error(`OpenChamber ${path}: unexpected content-type ${ct || "(none)"}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  listSessions(directory?: string): Promise<OcSession[]> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<OcSession[]>(`/api/session${qs}`);
  }

  /** Create a new session (defaults to OpenChamber's default directory). */
  createSession(title?: string, directory?: string): Promise<OcSession> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<OcSession>(`/api/session${qs}`, {
      method: "POST",
      body: JSON.stringify({ title: title ?? "New chat" }),
      headers: { "Content-Type": "application/json" },
      timeoutMs: 15000,
    });
  }

  listProjects(): Promise<Array<{ id: string; worktree?: string; sandboxes?: string[] }>> {
    return this.request<Array<{ id: string; worktree?: string; sandboxes?: string[] }>>("/api/project");
  }

  sessionActivity(): Promise<OcSessionActivity> {
    return this.request<OcSessionActivity>("/api/session-activity");
  }

  messages(sessionId: string, directory?: string): Promise<OcMessage[]> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<OcMessage[]>(
      `/api/session/${encodeURIComponent(sessionId)}/message${qs}`,
    );
  }

  /** Fire-and-forget prompt (204). Streaming arrives via the event stream. */
  promptAsync(
    sessionId: string,
    text: string,
    directory?: string,
    model?: { providerID: string; modelID: string },
    agent?: string,
  ): Promise<void> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<void>(
      `/api/session/${encodeURIComponent(sessionId)}/prompt_async${qs}`,
      {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        }),
        headers: { "Content-Type": "application/json" },
        timeoutMs: 15000,
      },
    );
  }

  pendingPermissions(): Promise<OcPermission[]> {
    return this.request<OcPermission[]>("/api/permission");
  }

  pendingQuestions(): Promise<OcQuestion[]> {
    return this.request<OcQuestion[]>("/api/question");
  }

  replyPermission(
    sessionId: string,
    requestId: string,
    response: "once" | "always" | "reject",
    directory?: string,
  ): Promise<void> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<void>(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply${qs}`,
      { method: "POST", body: JSON.stringify({ response }), headers: { "Content-Type": "application/json" } },
    );
  }

  replyQuestion(
    sessionId: string,
    requestId: string,
    answers: string[],
    directory?: string,
  ): Promise<void> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<void>(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply${qs}`,
      { method: "POST", body: JSON.stringify({ answers }), headers: { "Content-Type": "application/json" } },
    );
  }

  rejectQuestion(sessionId: string, requestId: string, directory?: string): Promise<void> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<void>(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject${qs}`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  interrupt(sessionId: string, directory?: string): Promise<void> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    return this.request<void>(
      `/api/session/${encodeURIComponent(sessionId)}/interrupt${qs}`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }
}
