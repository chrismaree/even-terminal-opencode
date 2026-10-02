// OpenCode v2 HTTP API client. Talks to OpenChamber (:57123), which proxies
// the opencode v2 `/api/*` surface, or directly to an opencode server.
// Verified against OpenChamber desktop 2.0.4 / opencode 2.0.20.

/** Normalized session row (v2 `Session.Info` with `location.directory` lifted). */
export interface OcSession {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  parentID?: string | null;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  time?: { created?: number; updated?: number; idle?: number; archived?: number | null };
}

export interface OcToolContent {
  type: "tool";
  id: string;
  name: string;
  state: {
    status?: string;
    input?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
    metadata?: Record<string, unknown>;
  };
}

export type OcAssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | OcToolContent;

/** v2 session message (flat, typed). Only the fields the bridge reads. */
export interface OcMessage {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  /** user / synthetic / system */
  text?: string;
  /** assistant */
  content?: OcAssistantContent[];
  cost?: number;
  tokens?: { input?: number; output?: number };
  error?: { message?: string };
  /** shell */
  command?: string;
}

/** v2 `Permission.Request`. */
export interface OcPermission {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  message?: string;
}

export interface OcFormOption {
  value: string;
  label: string;
  description?: string;
}

export interface OcFormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: OcFormOption[];
  custom?: boolean;
}

/** v2 `Form.Info` (ask-user questions are forms in v2). */
export interface OcForm {
  id: string;
  sessionID: string;
  title: string;
  fields: OcFormField[];
  metadata?: Record<string, unknown>;
}

export interface OcProject {
  id: string;
  /** v2 `canonical` */
  worktree?: string;
  sandboxes?: string[];
}

export type OcPermissionReply = "once" | "always" | "reject";

const DEFAULT_TIMEOUT_MS = 8000;

export class OpenChamberHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function unwrapData<T>(body: unknown): T {
  const obj = rec(body);
  return ("data" in obj ? obj.data : body) as T;
}

/** Lift v2 `location.directory` onto the flat `directory` the bridge uses. */
export function normalizeSession(raw: unknown): OcSession {
  const s = rec(raw);
  const location = rec(s.location);
  const directory =
    typeof location.directory === "string"
      ? location.directory
      : typeof s.directory === "string"
        ? s.directory
        : undefined;
  return { ...(s as unknown as OcSession), directory };
}

function locationQuery(directory?: string): string {
  return directory ? `?location[directory]=${encodeURIComponent(directory)}` : "";
}

export interface OpenChamberClientOptions {
  /** Full Authorization header value (e.g. `Basic …`) for protected servers. */
  authorization?: string;
  fetchImpl?: typeof fetch;
}

export class OpenChamberClient {
  readonly base: string;
  readonly authorization?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(base: string, opts: OpenChamberClientOptions | typeof fetch = {}) {
    const o = typeof opts === "function" ? { fetchImpl: opts } : opts;
    this.base = base.replace(/\/+$/, "");
    this.authorization = o.authorization;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** Headers for any upstream request (REST and the event stream). */
  authHeaders(): Record<string, string> {
    return this.authorization ? { Authorization: this.authorization } : {};
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const method = init.method ?? "GET";
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...this.authHeaders(),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = rec(await res.json());
          detail = typeof body.message === "string" ? `: ${body.message}` : "";
        } catch {
          // non-JSON error body
        }
        throw new OpenChamberHttpError(`${method} ${path.split("?")[0]} -> HTTP ${res.status}${detail}`, res.status);
      }
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── sessions ────────────────────────────────────────────

  /** Newest-first root sessions across every location (v2 lists globally). */
  async listSessions(limit = 50): Promise<OcSession[]> {
    const qs = new URLSearchParams({ limit: String(limit), order: "desc", parentID: "null" });
    const rows = unwrapData<unknown[]>(await this.request(`/api/session?${qs.toString()}`));
    return (Array.isArray(rows) ? rows : []).map(normalizeSession);
  }

  async getSession(id: string): Promise<OcSession> {
    return normalizeSession(unwrapData(await this.request(`/api/session/${encodeURIComponent(id)}`)));
  }

  /** Create a session; without a directory the server's default location is used. */
  async createSession(title?: string, directory?: string): Promise<OcSession> {
    const body: Record<string, unknown> = { title: title ?? "New chat" };
    if (directory) body.location = { directory };
    const created = await this.request("/api/session", { method: "POST", body, timeoutMs: 15000 });
    return normalizeSession(unwrapData(created));
  }

  /** Map of sessionId -> { type: "running" } for sessions currently executing. */
  async activeSessions(): Promise<Record<string, { type: string }>> {
    const data = unwrapData<Record<string, { type: string }>>(await this.request("/api/session/active"));
    return rec(data) as Record<string, { type: string }>;
  }

  /** Server default location (used to recognise projectless "chat" sessions). */
  async defaultDirectory(): Promise<string | undefined> {
    const loc = rec(await this.request("/api/location"));
    return typeof loc.directory === "string" ? loc.directory : undefined;
  }

  async listProjects(): Promise<OcProject[]> {
    const rows = unwrapData<unknown[]>(await this.request("/api/project"));
    return (Array.isArray(rows) ? rows : []).map((raw) => {
      const p = rec(raw);
      const worktree =
        typeof p.canonical === "string" ? p.canonical : typeof p.worktree === "string" ? p.worktree : undefined;
      return {
        id: String(p.id ?? ""),
        worktree,
        sandboxes: Array.isArray(p.sandboxes) ? p.sandboxes.map(String) : [],
      };
    });
  }

  /** Messages oldest-first (fetches the newest `limit`). */
  async messages(sessionId: string, limit = 100): Promise<OcMessage[]> {
    const qs = new URLSearchParams({ limit: String(limit), order: "desc" });
    const rows = unwrapData<OcMessage[]>(
      await this.request(`/api/session/${encodeURIComponent(sessionId)}/message?${qs.toString()}`),
    );
    return (Array.isArray(rows) ? rows : []).slice().reverse();
  }

  /** Non-blocking prompt: enqueued into the session inbox; output streams as events. */
  async prompt(sessionId: string, text: string): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { text },
      timeoutMs: 15000,
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
  }

  // ── permissions & forms (ask-user) ─────────────────────

  async pendingPermissions(directory?: string): Promise<OcPermission[]> {
    const rows = unwrapData<OcPermission[]>(await this.request(`/api/permission/request${locationQuery(directory)}`));
    return Array.isArray(rows) ? rows : [];
  }

  async pendingForms(directory?: string): Promise<OcForm[]> {
    const rows = unwrapData<OcForm[]>(await this.request(`/api/form${locationQuery(directory)}`));
    return Array.isArray(rows) ? rows : [];
  }

  async replyPermission(sessionId: string, requestId: string, decision: OcPermissionReply): Promise<void> {
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body: { decision } },
    );
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, {
      method: "POST",
      body: { answer },
    });
  }

  async cancelForm(sessionId: string, formId: string): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`, {
      method: "DELETE",
    });
  }
}
