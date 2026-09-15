import { randomBytes } from "node:crypto";
import express from "npm:express@^5.2.1";
import cors from "npm:cors@^2.8.6";
import eventsRouter from "./routes/events.js";
import coreRouter from "./routes/core.js";
import { CODEX_APP_SERVER_PORT, printServerBanner, stopCodexAppServer } from "./startup/common.js";
import { removeInstancePidfile, writeInstancePidfile } from "./startup/instance.js";
import { startExposeProvider } from "./expose/run.js";
import { installTimestampLogging } from "./logger.js";

// ── PORT NOTE (Deno/JSR) ───────────────────────────────
// Upstream index.js started the server as a side effect of `import`. Here it is
// wrapped in an exported `startServer(opts)` so an embedder (e.g. claude-tools)
// can `registerProvider("box", …)` FIRST and then start. The CLI (bin/cli.js)
// calls startServer() to preserve the original behavior. Routes read providers
// dynamically via getProvider(), so registering before startServer() is enough.

let processHandlersInstalled = false;
function installProcessHandlers() {
    if (processHandlersInstalled)
        return;
    processHandlersInstalled = true;
    process.on("uncaughtException", (err) => {
        console.error(`[server] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    });
    process.on("unhandledRejection", (reason) => {
        console.error(`[server] UNHANDLED REJECTION: ${reason}`);
    });
    const shutdown = () => { stopCodexAppServer(); removeInstancePidfile(); };
    process.on("exit", shutdown);
    process.on("SIGINT", () => { shutdown(); process.exit(0); });
    process.on("SIGTERM", () => { shutdown(); process.exit(0); });
}

/**
 * Start the Even Terminal bridge server.
 * @param {object} [opts]
 * @param {number} [opts.port]            overrides $PORT (default 3456)
 * @param {string} [opts.token]           overrides $BRIDGE_TOKEN (default random hex)
 * @param {string} [opts.cwd]             project dir shown in the banner ($PROJECT_DIR)
 * @param {string} [opts.defaultProvider] default provider name ($DEFAULT_PROVIDER)
 * @param {boolean} [opts.printQr=true]   print the pairing QR to the terminal
 * @returns {Promise<{ port: number, token: string, server: import("node:http").Server }>}
 */
export function startServer(opts = {}) {
    if (opts.defaultProvider)
        process.env.DEFAULT_PROVIDER = opts.defaultProvider;
    if (opts.cwd)
        process.env.PROJECT_DIR = opts.cwd;
    const PORT = opts.port ?? parseInt(process.env.PORT ?? "3456", 10);
    const TOKEN = opts.token ?? process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex");
    const printQr = opts.printQr ?? true;

    const app = express();
    app.use(cors());
    app.use((req, res, next) => {
        const startedAt = process.hrtime.bigint();
        res.on("finish", () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            console.log(`[${req.ip}] ${res.statusCode} ${req.method} ${req.originalUrl} ${durationMs.toFixed(1)}ms`);
        });
        next();
    });
    app.use(express.json({ limit: "10mb" }));

    // ── Auth middleware ────────────────────────────────────
    function auth(req, res, next) {
        const header = req.headers.authorization;
        const queryToken = req.query.token;
        const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
        if (provided !== TOKEN) {
            console.warn(`[auth] 401 ${req.method} ${req.url} (ip=${req.ip})`);
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        next();
    }
    app.use("/api", auth, eventsRouter);
    app.use("/api", auth, coreRouter);

    installProcessHandlers();
    return new Promise((resolve) => {
        const server = app.listen(PORT, "0.0.0.0", () => {
            printServerBanner(PORT, TOKEN, process.env.PROJECT_DIR || process.cwd(), printQr);
            // codex app-server is lazy-spawned on first codex API call; the
            // `even-terminal codex` subcommand discovers this process via the
            // pidfile written here and pokes POST /api/codex/ensure-app-server.
            try {
                writeInstancePidfile({
                    port: PORT,
                    token: TOKEN,
                    cwd: process.env.PROJECT_DIR || process.cwd(),
                    codexAppServerPort: CODEX_APP_SERVER_PORT,
                });
            }
            catch (err) {
                console.error(`[server] WARN: failed to write instance pidfile: ${err?.message}`);
            }
            startExposeProvider(PORT, TOKEN);
            installTimestampLogging();
            resolve({ port: PORT, token: TOKEN, server });
        });
    });
}
