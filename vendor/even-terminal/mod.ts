// @monsterrg/even-terminal — a Deno/JSR port of Even Realities' `even-terminal`
// (npm: @evenrealities/even-terminal, MIT). Runs the bridge server that mirrors
// an AI coding agent onto Even Realities G2 glasses and routes R1 ring input
// back. This port adds an INJECTABLE provider registry so an embedder can add
// its own provider — e.g. a "box" provider that lists sandboxed Claude sessions
// by project and drives each live — without forking the request/rendering layer.
//
// Public API. Typical embedder usage:
//
//   import { startServer, registerProvider } from "@monsterrg/even-terminal";
//   registerProvider("box", (emit) => createBoxProvider(emit)); // your provider
//   await startServer({ defaultProvider: "box", token: "…" });
//
// A provider is an object implementing:
//   listSessions(limit, cwd) -> Array<{ id, title, timestamp, cwd, provider, status }>
//   getSessionStatus(id) -> "idle" | "busy"
//   getInfo() -> { account, model, version, provider }
//   getHistory(id, limit) -> Array<{ role, text }>
//   prompt(sessionId, text, cwd) -> { sessionId, provider }
//   respondPermission(id, decision), respondQuestion(id, answer), interrupt(id)
//   getStatus(id) -> { state, provider } | null
// where `factory(emit)` receives the SSE emitter `emit(sessionId, msg)`; the
// glasses render messages by `type` (text_delta, tool_start/end, result,
// permission_request, user_question, status, notification, error, user_prompt).

export { startServer } from "./dist/index.js";
export { getProvider, registerProvider } from "./dist/routes/core.js";
export { broadcast, getMessages, pushMessage } from "./dist/routes/events.js";
export { createClaudeProvider } from "./dist/claude/provider.js";
export { createCodexProvider } from "./dist/codex/provider.js";
export {
  getDefaultProvider,
  isProvider,
  parseProvider,
  SUPPORTED_PROVIDERS,
} from "./dist/session.js";
