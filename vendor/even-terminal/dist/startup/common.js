import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import qrcodeTerminal from "npm:qrcode-terminal@^0.12.0";
import { getDefaultProvider } from "../session.js";
import { spawnShim } from "../util/spawn-shim.js";
import { VERSION } from "../version.js";
export const CODEX_APP_SERVER_PORT = parseInt(process.env.CODEX_APP_SERVER_PORT || "8765", 10);
const pkg = { version: VERSION };
export function getLanAddress() {
    const nets = networkInterfaces();
    for (const ifaces of Object.values(nets)) {
        for (const iface of ifaces ?? []) {
            if (iface.family === "IPv4" && !iface.internal)
                return iface.address;
        }
    }
}
function getTailscaleIp() {
    try {
        // execSync always uses a shell (/bin/sh on POSIX, ComSpec on Windows),
        // so no explicit shell option is needed.
        const out = execSync("tailscale ip -4", {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
        }).toString().trim();
        const first = out.split("\n")[0]?.trim();
        return first || undefined;
    }
    catch {
        return undefined;
    }
}
function getInterfaceIp(name) {
    const ifaces = networkInterfaces()[name];
    if (!ifaces)
        return undefined;
    for (const iface of ifaces) {
        if (iface.family === "IPv4")
            return iface.address;
    }
    return undefined;
}
/** Resolve host based on EVEN_HOST_MODE / EVEN_HOST_INTERFACE; exits on failure. */
export function resolveHost() {
    const mode = process.env.EVEN_HOST_MODE;
    if (mode === "tailscale") {
        const ip = getTailscaleIp();
        if (!ip) {
            console.error("error: failed to get Tailscale IPv4 address (is `tailscale` installed and running?)");
            process.exit(1);
        }
        return { label: "Tailscale", address: ip };
    }
    if (mode === "interface") {
        const name = process.env.EVEN_HOST_INTERFACE ?? "";
        if (!name) {
            console.error("error: --interface requires a name");
            process.exit(1);
        }
        const ip = getInterfaceIp(name);
        if (!ip) {
            console.error(`error: failed to get IPv4 address for interface "${name}"`);
            process.exit(1);
        }
        return { label: name, address: ip };
    }
    return { label: "LAN", address: getLanAddress() ?? "" };
}
export function truncPath(p, max) {
    if (p.length <= max)
        return p;
    return "..." + p.slice(-(max - 3));
}
function detectColorLevel() {
    const { TERM, COLORTERM } = process.env;
    if (!process.stdout.isTTY)
        return "none";
    if (TERM === "dumb")
        return "none";
    if (COLORTERM === "truecolor" || COLORTERM === "24bit")
        return "truecolor";
    if (TERM && /-256(color)?$/i.test(TERM))
        return "ansi256";
    if (TERM && /color|xterm|screen|vt100|ansi|cygwin|linux/i.test(TERM))
        return "basic";
    return "none";
}
function wrapQrColors(code, level) {
    let bg;
    let fg;
    switch (level) {
        case "truecolor":
            bg = "\x1b[48;2;0;0;0m";
            fg = "\x1b[38;2;255;255;255m";
            break;
        case "ansi256":
            bg = "\x1b[48;5;16m";
            fg = "\x1b[38;5;231m";
            break;
        case "basic":
            bg = "\x1b[40m";
            fg = "\x1b[37m";
            break;
        case "none":
            return code;
    }
    const reset = "\x1b[0m";
    const lines = code.split("\n");
    while (lines.length && lines[0].trim() === "")
        lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "")
        lines.pop();
    return lines
        .map((line, i) => {
        const prefix = i === 0 && /^\u2584+$/.test(line) ? fg : `${bg}${fg}`;
        return `${prefix}${line}${reset}`;
    })
        .join("\n");
}
/** Write directly to stdout, bypassing the timestamp-patched console.log.
 *  Use this for visual output (banners, QR codes) that must not be prefixed. */
export function rawLog(msg = "") {
    process.stdout.write(msg + "\n");
}
export function printQRCode(str, afterCb) {
    const level = detectColorLevel();
    qrcodeTerminal.generate(str, { small: true }, (code) => {
        rawLog(wrapQrColors(code, level));
        if (afterCb)
            afterCb();
    });
}
let codexAppServerProcess = null;
function isPortTakenError(text) {
    return /\bEADDRINUSE\b|address already in use|addrinuse/i.test(text);
}
function canBindLocalPort(port) {
    return new Promise((resolve) => {
        const server = createServer();
        let settled = false;
        const done = (available) => {
            if (settled)
                return;
            settled = true;
            server.close(() => resolve(available));
        };
        server.once("error", (err) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
                return;
            }
            console.error(`[codex] WARN: Failed to bind-check port ${port}: ${err.message}`);
            resolve(false);
        });
        server.once("listening", () => done(true));
        server.listen(port, "127.0.0.1");
    });
}
export async function startCodexAppServer() {
    const listenUrl = `ws://127.0.0.1:${CODEX_APP_SERVER_PORT}`;
    if (!(await canBindLocalPort(CODEX_APP_SERVER_PORT))) {
        console.error(`[codex] ERROR: Port ${CODEX_APP_SERVER_PORT} appears to be in use. Set CODEX_APP_SERVER_PORT to another port and restart.`);
        console.error(`[codex] ERROR: Codex app-server was not started.`);
        console.error(`[codex] NOTE: This is harmless if you only intend to use Claude (or providers other than Codex).`);
        return false;
    }
    return new Promise((resolve) => {
        let resolved = false;
        let started = false;
        const done = () => { if (!resolved) {
            resolved = true;
            resolve(started);
        } };
        let stderrText = "";
        let printedPortHint = false;
        const printPortHint = (text) => {
            if (printedPortHint || !isPortTakenError(text))
                return;
            printedPortHint = true;
            console.error(`[codex] ERROR: Port ${CODEX_APP_SERVER_PORT} appears to be in use. Set CODEX_APP_SERVER_PORT to another port and restart.`);
        };
        let child;
        try {
            child = spawnShim("codex", ["app-server", "--listen", listenUrl], {
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (err) {
            console.error(`[codex] ERROR: Failed to spawn codex app-server: ${err.message}`);
            console.error(`[codex] ERROR: Codex provider will not work in this environment.`);
            console.error(`[codex] NOTE: This is harmless if you only intend to use Claude (or providers other than Codex).`);
            done();
            return;
        }
        child.on("error", (err) => {
            console.error(`[codex] ERROR: Failed to start codex app-server: ${err.message}`);
            printPortHint(err.message);
            console.error(`[codex] ERROR: Codex provider will not work in this environment.`);
            console.error(`[codex] NOTE: This is harmless if you only intend to use Claude (or providers other than Codex).`);
            codexAppServerProcess = null;
            done();
        });
        child.on("close", (code) => {
            if (code !== null && code !== 0) {
                console.error(`[codex] ERROR: codex app-server exited with code ${code}`);
                printPortHint(stderrText);
                console.error(`[codex] NOTE: This is harmless if you only intend to use Claude (or providers other than Codex).`);
            }
            codexAppServerProcess = null;
            done();
        });
        child.stderr?.on("data", (data) => {
            const text = data.toString().trim();
            if (text) {
                stderrText += `${text}\n`;
                console.log(`[codex-app-server] ${text}`);
                printPortHint(text);
                // app-server prints "listening on:" to stderr when ready
                if (text.includes("listening on:")) {
                    started = true;
                    done();
                }
            }
        });
        child.stdout?.on("data", (data) => {
            const text = data.toString().trim();
            if (text)
                console.log(`[codex-app-server] ${text}`);
        });
        codexAppServerProcess = child;
        console.log(`[codex] app-server starting on ${listenUrl}`);
        // Fallback timeout in case we miss the ready signal
        setTimeout(done, 5000);
    });
}
export function stopCodexAppServer() {
    if (codexAppServerProcess) {
        codexAppServerProcess.kill();
        codexAppServerProcess = null;
    }
}
/**
 * Spawn the codex app-server on first call (and re-spawn if it died). Concurrent
 * callers share the same in-flight promise; on any settlement (success or failure)
 * the cached promise is cleared so the next API call can retry — the user may
 * have fixed the env (PATH, port conflict, missing binary, …) since the last
 * attempt. No background retries: spawn happens only when something asks for it.
 */
let codexAppServerStartPromise = null;
export function ensureCodexAppServerStarted() {
    if (codexAppServerProcess
        && codexAppServerProcess.exitCode === null
        && codexAppServerProcess.signalCode === null) {
        return Promise.resolve(true);
    }
    if (codexAppServerStartPromise)
        return codexAppServerStartPromise;
    codexAppServerStartPromise = startCodexAppServer().finally(() => {
        codexAppServerStartPromise = null;
    });
    return codexAppServerStartPromise;
}
export function buildClientQuery(token) {
    const defaultProvider = getDefaultProvider();
    const name = process.env.EVEN_TERMINAL_NAME ?? "";
    const params = new URLSearchParams({ token, defaultProvider });
    if (name)
        params.set("name", name);
    return params;
}
export function printServerBanner(port, token, cwd, printQr) {
    const host = resolveHost();
    const name = process.env.EVEN_TERMINAL_NAME ?? "";
    const labelWidth = Math.max("Local".length, "Token".length, "Name".length, "CWD".length, host.label.length);
    const pad = (s) => s.padEnd(labelWidth);
    const logo = [
        "██  ████████",
        "████        ",
        "██  ████████",
        "████        ",
        "██  ████████",
    ];
    const info = [
        `Even Terminal v${pkg.version}`,
        name ? `${pad("Name")}:  ${name}` : "",
        `${pad("Local")}:  http://localhost:${port}`,
        host.address ? `${pad(host.label)}:  http://${host.address}:${port}` : "",
        `${pad("Token")}:  ${token.slice(0, 8)}...${token.slice(-4)}`,
        `${pad("CWD")}:  ${truncPath(cwd, 40)}`,
        "",
        "",
    ];
    const gap = "     ";
    rawLog("");
    for (let i = 0; i < Math.max(logo.length, info.length); i++) {
        const logoLine = (logo[i] ?? "").padEnd(12);
        rawLog(`  ${logoLine}${gap}${info[i] ?? ""}`);
    }
    rawLog("");
    rawLog("  Made by Even Realities \u00b7 Connect your terminal to G2 glasses");
    rawLog("  " + "\u2500".repeat(61));
    rawLog("");
    rawLog(`  Full token: ${token}`);
    rawLog("");
    const params = buildClientQuery(token);
    const address = host.address || "localhost";
    const url = `http://${address}:${port}?${params.toString()}`;
    if (printQr && host.address) {
        rawLog(url);
        printQRCode(url, () => rawLog(""));
    }
}
