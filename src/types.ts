// Even-terminal wire contract (mirrors vendor/even-terminal/dist/claude/session.js
// and dist/routes/core.js — kept in sync with the vendored MIT reference).

/** Messages streamed to the glasses over /api/events (SSE), one per `type`. */
export type EvenMessage =
  | { type: "text_delta"; text: string }
  | { type: "user_prompt"; text: string }
  | { type: "status"; state: string; sessionId?: string }
  | {
      type: "tool_start";
      name: string;
      toolId: string;
    }
  | {
      type: "tool_end";
      name: string;
      toolId: string;
      summary: string;
      detail?: { input?: unknown; output?: string };
    }
  | {
      type: "permission_request";
      toolName: string;
      description: string;
      detail: string;
      toolUseId: string;
      options: Array<{ text: string; key: string }>;
      suggestions?: unknown;
    }
  | {
      type: "permission_result";
      toolName: string;
      summary: string;
      decision: "allowed" | "denied" | "always";
    }
  | {
      type: "user_question";
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string; preview?: string }>;
      }>;
      toolUseId: string;
    }
  | { type: "question_answer"; answers: Record<string, string> }
  | {
      type: "result";
      success: boolean;
      text: string;
      sessionId: string;
      costUsd: number;
      provider: string;
      turns?: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: "notification"; title?: string; message: string }
  | {
      type: "running_stats";
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: "task_progress"; completed: number; total: number; current: string }
  | { type: "error"; message: string };

export type Emit = (sessionId: string, msg: EvenMessage) => void;

/** Session row as returned by GET /api/sessions. */
export interface EvenSession {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: string;
  status: string | null;
}

/** History row as returned by GET /api/sessions/:id/history. */
export interface HistoryItem {
  role: string;
  text: string;
}

export interface ProviderInfo {
  account: Record<string, string>;
  model: string;
  version: string;
  provider: string;
}

/**
 * The 9-method provider interface consumed by the bridge routes.
 * (Same shape as createClaudeProvider(emit) in the vendored contract.)
 */
export interface EvenProvider {
  listSessions(limit: number, cwd?: string): Promise<EvenSession[]>;
  getSessionStatus(id: string): Promise<string>;
  getInfo(): Promise<ProviderInfo>;
  getHistory(id: string, limit: number): Promise<HistoryItem[]>;
  prompt(sessionId: string, text: string, cwd?: string): Promise<{
    sessionId: string;
    provider: string;
  }>;
  respondPermission(id: string, decision: string): void;
  respondQuestion(id: string, answer: string): void;
  interrupt(id: string): void;
  getStatus(id: string): { state: string; provider: string } | null;
}

/** Decisions arriving on POST /api/permission-response. */
export type PermissionDecision = "allow" | "allowAlways" | "deny";
