import { Router } from "npm:express@^5.2.1";
import { getDefaultProvider, isProvider, parseProvider, SUPPORTED_PROVIDERS } from "../session.js";
import { broadcast, pushMessage, getMessages } from "./events.js";
import { createClaudeProvider } from "../claude/provider.js";
import { createCodexProvider } from "../codex/provider.js";
// cursor/opencode hidden in 0.8.1 (experimental) — re-enable alongside SUPPORTED_PROVIDERS.
// import { createCursorProvider } from "../cursor/provider.js";
// import { createOpencodeProvider } from "../opencode/provider.js";
import { CodexAppServerClient } from "../codex/app-server.js";
import { debugLog } from "../debug.js";
import { CODEX_APP_SERVER_PORT, ensureCodexAppServerStarted } from "../startup/common.js";
import { checkForUpdate, getCurrentAppVersion } from "../update.js";
const router = Router();
const emit = (sessionId, msg) => {
    if (!sessionId)
        return;
    const id = pushMessage(sessionId, msg);
    broadcast(sessionId, msg, id);
};
const STATUS_CHECK_COUNT = 10;
function toOneLineJson(value, maxLen = 1200) {
    try {
        const text = JSON.stringify(value);
        if (!text)
            return String(value);
        return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    }
    catch {
        return String(value);
    }
}
const codexClient = new CodexAppServerClient(`ws://127.0.0.1:${CODEX_APP_SERVER_PORT}`);
const claudeProvider = createClaudeProvider(emit);
const codexProvider = createCodexProvider(emit, () => codexClient);
// const cursorProvider = createCursorProvider(emit);
// const opencodeProvider = createOpencodeProvider(emit);
const providerRegistry = {
    claude: claudeProvider,
    codex: codexProvider,
    // cursor: cursorProvider,
    // opencode: opencodeProvider,
};
export { codexClient };
export function getProvider(name) {
    const resolved = name ? parseProvider(name) : getDefaultProvider();
    const handlers = providerRegistry[resolved];
    if (!handlers)
        throw new Error(`No handlers registered for provider "${resolved}"`);
    return handlers;
}
// ── PORT ADDITION (Deno/JSR) ───────────────────────────
// Upstream hardcoded providerRegistry = { claude, codex }. This lets an embedder
// inject a provider (e.g. a "box" provider that drives sandboxed Claude sessions)
// BEFORE startServer(). `factory(emit)` returns the same handler shape as
// createClaudeProvider(emit). Registering also makes the name valid for
// isProvider/parseProvider (SUPPORTED_PROVIDERS is a shared, mutable array).
export function registerProvider(name, factory) {
    const handlers = factory(emit);
    providerRegistry[name] = handlers;
    if (!SUPPORTED_PROVIDERS.includes(name))
        SUPPORTED_PROVIDERS.push(name);
    return handlers;
}
router.use((req, res, next) => {
    for (const provider of [req.query.provider, req.body?.provider]) {
        if (provider !== undefined && !isProvider(provider)) {
            res.status(400).json({ error: `Unsupported provider "${String(provider)}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}` });
            return;
        }
    }
    next();
});
// GET /api/sessions — list resumable sessions
router.get("/sessions", async (req, res) => {
    const providerName = req.query.provider;
    const resolvedProvider = providerName ? parseProvider(providerName) : getDefaultProvider();
    const cwd = req.query.cwd || (resolvedProvider === "codex" ? undefined : process.env.PROJECT_DIR);
    const provider = getProvider(resolvedProvider);
    const limit = Number(req.query.limit) || 10;
    try {
        const sessions = await provider.listSessions(limit, cwd);
        await Promise.all(sessions.slice(0, STATUS_CHECK_COUNT).map(async (s, i) => {
            if (s.status)
                return;
            sessions[i].status = await provider.getSessionStatus(s.id);
        }));
        res.json({ sessions });
    }
    catch (err) {
        res.json({ sessions: [], error: err.message });
    }
});
// GET /api/info — account, model, version, provider
router.get("/info", async (req, res) => {
    const providerName = req.query.provider;
    const provider = getProvider(providerName);
    try {
        const info = await provider.getInfo();
        res.json(info);
    }
    catch (err) {
        res.json({ account: {}, model: "Unknown", version: "Unknown", error: err.message });
    }
});
// GET /api/update-check — current app version and latest npm version
router.get("/update-check", async (_req, res) => {
    try {
        res.json(await checkForUpdate());
    }
    catch (err) {
        res.json({
            ...getCurrentAppVersion(),
            newestVersion: null,
            updateAvailable: null,
            error: err.message,
        });
    }
});
// POST /api/prompt — send a prompt to a session (create if needed)
router.post("/prompt", async (req, res) => {
    const { text, sessionId, provider, cwd } = req.body ?? {};
    console.log(`[prompt] sessionId=${sessionId ?? "(none)"} (provider=${provider}) text=${(text || "").slice(0, 80)}`);
    if (!text || typeof text !== "string") {
        console.warn("[prompt] rejected: missing text field");
        res.status(400).json({ error: "Missing 'text' field" });
        return;
    }
    try {
        const p = provider || getDefaultProvider();
        const targetProvider = getProvider(p);
        const result = await targetProvider.prompt(sessionId, text, cwd);
        res.status(202).json({ ok: true, sessionId: result.sessionId, provider: result.provider });
    }
    catch (err) {
        console.error("[prompt] failed:", err.message);
        const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
        res.status(statusCode).json({ error: err.message });
    }
});
// POST /api/permission-response
router.post("/permission-response", (req, res) => {
    const { sessionId, decision, provider } = req.body ?? {};
    console.log(`[permission-response] sessionId=${sessionId ?? "(none)"} provider=${provider ?? "(default)"} decision=${decision ?? "deny"}`);
    debugLog("api", "permission-response body", toOneLineJson(req.body ?? {}));
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const targetProvider = getProvider(provider);
    if (!targetProvider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    targetProvider.respondPermission(sessionId, decision || "deny");
    res.json({ ok: true });
});
// POST /api/question-response
router.post("/question-response", (req, res) => {
    const { sessionId, answer, provider } = req.body ?? {};
    console.log(`[question-response] sessionId=${sessionId ?? "(none)"} provider=${provider ?? "(default)"} answer=${String(answer ?? "skip").slice(0, 120)}`);
    debugLog("api", "question-response body", toOneLineJson(req.body ?? {}));
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const targetProvider = getProvider(provider);
    if (!targetProvider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    targetProvider.respondQuestion(sessionId, answer || "skip");
    res.json({ ok: true });
});
// POST /api/interrupt
router.post("/interrupt", (req, res) => {
    const { sessionId, provider } = req.body ?? {};
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const targetProvider = getProvider(provider);
    if (!targetProvider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    targetProvider.interrupt(sessionId);
    res.json({ ok: true });
});
// GET /api/status
router.get("/status", (req, res) => {
    const sessionId = req.query.sessionId;
    const providerName = req.query.provider;
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const status = getProvider(providerName).getStatus(sessionId);
    if (!status) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    res.json({
        state: status.state,
        sessionId,
        provider: status.provider,
    });
});
// GET /api/messages?sessionId=&after=
router.get("/messages", (req, res) => {
    const after = parseInt(req.query.after) || 0;
    const sessionId = req.query.sessionId;
    const providerName = req.query.provider;
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const status = getProvider(providerName).getStatus(sessionId);
    const messages = getMessages(sessionId, after);
    res.json({
        messages,
        state: status?.state ?? "idle",
        sessionId,
        provider: status?.provider ?? providerName ?? null,
    });
});
// GET /api/debug/thread/:id — raw app-server / SDK output for debugging
router.get("/debug/thread/:id", async (req, res) => {
    const id = req.params.id;
    const provider = req.query.provider || getDefaultProvider();
    try {
        if (provider === "codex") {
            const thread = await codexClient.threadRead(id, true);
            res.json(thread);
        }
        else if (provider === "claude") {
            const { getSessionMessages } = await import("npm:@anthropic-ai/claude-agent-sdk@^0.2.118");
            const messages = await getSessionMessages(id);
            res.json({ sessionId: id, messages });
        }
        else {
            // ACP providers (cursor, opencode): no raw SDK dump — surface the
            // provider's reconstructed history so the debug view still has content.
            const history = await getProvider(provider).getHistory(id, 50);
            res.json({ sessionId: id, messages: history });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/debug/status/:id — test status detection against real data
router.get("/debug/status/:id", async (req, res) => {
    const id = req.params.id;
    const providerName = req.query.provider || getDefaultProvider();
    const provider = getProvider(providerName);
    try {
        const status = await provider.getSessionStatus(id);
        res.json({ sessionId: id, provider: providerName, status });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/sessions/:id/history
router.get("/sessions/:id/history", async (req, res) => {
    const id = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 10, 10);
    const providerName = req.query.provider || getDefaultProvider();
    const provider = getProvider(providerName);
    try {
        const history = await provider.getHistory(id, limit);
        res.json({ history });
    }
    catch (err) {
        res.json({ history: [], error: err.message });
    }
});
// GET /api/metrics — codex subscription state for monitoring
router.get("/metrics", (_req, res) => {
    const subscribed = codexProvider.getSubscribedSessions();
    res.json({ codex: { subscribedSessions: subscribed } });
});
// POST /api/codex/ensure-app-server — wake the lazy codex app-server.
// Used by `even-terminal codex`, which spawns `codex --remote` directly
// against ws://127.0.0.1:<codexAppServerPort> and otherwise has no way
// to trigger the lazy spawn.
router.post("/codex/ensure-app-server", async (_req, res) => {
    try {
        const started = await ensureCodexAppServerStarted();
        res.json({ started, port: CODEX_APP_SERVER_PORT });
    }
    catch (err) {
        res.status(500).json({ started: false, error: err?.message ?? String(err) });
    }
});
export default router;
