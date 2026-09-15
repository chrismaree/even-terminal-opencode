#!/usr/bin/env node

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import yargs from "npm:yargs@^18.0.0";
import { hideBin } from "npm:yargs@^18.0.0/helpers";
import { getExposeProviderNames } from "../dist/expose/registry.js";
import { SUPPORTED_PROVIDERS } from "../dist/session.js";
import { spawnSyncShim } from "../dist/util/spawn-shim.js";
import { VERSION } from "../dist/version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = { version: VERSION };
const INSTANCE_DIR = join(homedir(), ".even-terminal", "instances");
const exposeProviderNames = getExposeProviderNames();
const exposeProviderList = exposeProviderNames.join(", ");
const providerNames = [...SUPPORTED_PROVIDERS];
const optionDefinitions = {
  port: {
    alias: "p",
    type: "number",
    describe: "Server port",
    default: 3456,
  },
  token: {
    alias: "t",
    type: "string",
    describe: "Auth token (default: auto-generated)",
  },
  name: {
    alias: "n",
    type: "string",
    describe: "Client display name",
  },
  cwd: {
    alias: "d",
    type: "string",
    describe: "Project directory (where Claude Code sessions live)",
  },
  provider: {
    type: "string",
    choices: providerNames,
    describe: "Default AI provider",
  },
  tailscale: {
    type: "boolean",
    describe: "Use Tailscale IPv4 address instead of LAN",
  },
  interface: {
    alias: ["i", "if"],
    type: "string",
    describe: "Use the IPv4 address of the named network interface",
  },
  expose: {
    type: "string",
    array: true,
    requiresArg: true,
    choices: exposeProviderNames,
    describe: `Quick public expose provider (${exposeProviderList})`,
  },
  "log-file": {
    type: "string",
    describe: "Tee all logs to a file (default: ./even-terminal-<ts>.log)",
  },
  verbose: {
    type: "boolean",
    describe: "Print raw SDK messages for debugging",
  },
};

function registerCompletionOptions(command) {
  for (const [name, option] of Object.entries(optionDefinitions)) {
    const alias = Array.isArray(option.alias) ? option.alias[0] : option.alias;
    if (option.choices) {
      command.option(name, option.describe, (done) => {
        for (const value of option.choices) done(value, value);
      }, alias);
    } else if (option.type === "boolean") {
      command.option(name, option.describe, alias);
    } else {
      command.option(name, option.describe, () => {}, alias);
    }
  }
}

function registerYargsOptions(parser) {
  let next = parser;
  for (const [name, option] of Object.entries(optionDefinitions)) {
    next = next.option(name, option);
  }
  return next;
}

function registerCompletionCommands(root) {
  const start = root.command("start", "Start the server (default)");
  const complete = root.command("complete", "Print shell completion script for bash, zsh, fish, or powershell");

  registerCompletionOptions(root);
  registerCompletionOptions(start);
  complete.argument("shell", (done) => {
    done("bash", "Bash shell");
    done("zsh", "Zsh shell");
    done("fish", "Fish shell");
    done("powershell", "PowerShell");
  });
}

async function runCompletion(shell, forwardedArgs = []) {
  const t = (await import("npm:@bomb.sh/tab@^0.0.14")).default;
  registerCompletionCommands(t);

  if (shell === "--") {
    t.parse(forwardedArgs);
  } else {
    t.setup("even-terminal", "even-terminal", shell);
  }
}

// ── Completion (bash/zsh/fish/powershell) ────────────
// Handled before yargs so "complete" isn't rejected by strict mode.

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "complete") {
  await runCompletion(rawArgs[1], rawArgs.slice(2));
  process.exit(0);
}
if (rawArgs[0] === "codex") {
  await runCodex(rawArgs.slice(1));
  // unreachable — runCodex calls process.exit
}

// ── CLI ──────────────────────────────────────────────

registerYargsOptions(yargs(hideBin(process.argv))
  .scriptName("even-terminal")
  .help("help").alias("h", "help")
  .version("version", "Show version number", pkg.version).alias("v", "version")
  .usage("$0 [command] [options]")
  .command("start", "Start the server (default)", {}, run)
  .command(
    "complete <shell>",
    "Print shell completion script for bash, zsh, fish, or powershell",
    (command) => command.positional("shell", {
      describe: "Target shell (bash, zsh, fish, powershell)",
      choices: ["bash", "zsh", "fish", "powershell"],
      type: "string",
    }),
    async (argv) => {
      await runCompletion(argv.shell);
    },
  )
  .command("$0", false, {}, run))
  .check((argv) => {
    if (argv.tailscale && argv.interface) {
      throw new Error("--tailscale and --interface are mutually exclusive");
    }
    if (Array.isArray(argv.expose) && argv.expose.length > 1) {
      throw new Error("only one --expose provider may be specified");
    }
    return true;
  })
  .group(["tailscale", "interface"], "Local network options:")
  .group(["expose"], "Quick public expose options:")
  .strict()
  .example("even-terminal", "Start with defaults")
  .example("even-terminal -p 8080", "Start on port 8080")
  .example("even-terminal -t mytoken123", "Start with a fixed token")
  .example("npx even-terminal", "Run without installing")
  .example("even-terminal --expose pinggy", "Start with a quick public expose helper")
  .epilogue(
    "Quick public expose helpers are intended for simple temporary sharing, not long-term use.\n" +
    "For stable setups, prefer a proper network path such as Tailscale or a production tunnel configuration.\n\n" +
    "Shell completion (example usage):\n" +
    "  source <(even-terminal complete zsh)\n" +
    "  source <(even-terminal complete bash)\n" +
    "  even-terminal complete fish > ~/.config/fish/completions/even-terminal.fish\n" +
    "  even-terminal complete powershell >> $PROFILE"
  )
  .parse();

async function run(argv) {
  // Set env vars from flags before importing the server
  if (argv.port !== 3456) process.env.PORT = String(argv.port);
  if (argv.token) process.env.BRIDGE_TOKEN = argv.token;
  if (argv.name) process.env.EVEN_TERMINAL_NAME = argv.name;
  if (argv.cwd) process.env.PROJECT_DIR = resolve(argv.cwd);
  if (argv.provider) process.env.DEFAULT_PROVIDER = argv.provider;
  if (argv.verbose) process.env.VERBOSE = "1";

  {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = argv.logFile || `even-terminal-${stamp}.log`;
    process.argv.push("--log-file", resolve(filename));
  }

  if (argv.tailscale) {
    process.env.EVEN_HOST_MODE = "tailscale";
  } else if (argv.interface) {
    process.env.EVEN_HOST_MODE = "interface";
    process.env.EVEN_HOST_INTERFACE = argv.interface;
  }

  if (Array.isArray(argv.expose) && argv.expose[0]) {
    process.env.EVEN_TERMINAL_EXPOSE_PROVIDER = argv.expose[0];
  }

  // Boot the server (upstream imported ./dist/index.js for its side effect;
  // the Deno port exports startServer() instead — see dist/index.js PORT NOTE).
  const { startServer } = await import("../dist/index.js");
  await startServer();
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function listLiveInstances() {
  let entries;
  try {
    entries = readdirSync(INSTANCE_DIR);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const live = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(INSTANCE_DIR, name);
    let info;
    try {
      info = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      try { unlinkSync(path); } catch {}
      continue;
    }
    if (typeof info.pid !== "number" || !isPidAlive(info.pid)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    live.push(info);
  }
  live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return live;
}

function formatAge(startedAt) {
  const secs = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function promptChoice(instances) {
  return new Promise((resolveChoice, reject) => {
    process.stderr.write("Multiple even-terminal servers are running. Pick one to wake codex through:\n");
    instances.forEach((inst, i) => {
      process.stderr.write(
        `  [${i + 1}] pid=${inst.pid} port=${inst.port} codex-port=${inst.codexAppServerPort} ` +
        `age=${formatAge(inst.startedAt)} cwd=${inst.cwd}\n`
      );
    });
    if (!process.stdin.isTTY) {
      reject(new Error(
        "stdin is not a TTY; cannot prompt. Stop all but one even-terminal server and retry."
      ));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Choice [1-${instances.length}]: `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > instances.length) {
        reject(new Error(`Invalid choice "${answer.trim()}"`));
        return;
      }
      resolveChoice(instances[idx - 1]);
    });
  });
}

function postEnsureAppServer(instance, timeoutMs = 8000) {
  return new Promise((resolveReq, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: instance.port,
      path: "/api/codex/ensure-app-server",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${instance.token}`,
        "Content-Length": "0",
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolveReq(JSON.parse(body));
        } catch (err) {
          reject(new Error(`bad JSON from ensure-app-server: ${err.message}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

function probePort(port, timeoutMs = 500) {
  return new Promise((resolveProbe) => {
    const socket = netConnect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port, totalMs = 6000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function runCodex(extraArgs) {
  const cwd = process.cwd();
  const envPortRaw = process.env.CODEX_APP_SERVER_PORT;
  const envPort = envPortRaw ? parseInt(envPortRaw, 10) : null;

  let codexPort = envPort ?? 8765;

  if (!(await probePort(codexPort))) {
    let instances;
    try {
      instances = listLiveInstances();
    } catch (err) {
      console.error(`[codex] WARN: failed to read instance dir: ${err.message}`);
      instances = [];
    }

    if (envPort != null) {
      instances = instances.filter((i) => i.codexAppServerPort === envPort);
    }

    if (instances.length === 0) {
      console.error(
        "[codex] no running even-terminal server found to wake the codex app-server.\n" +
        "[codex] start one in another shell (e.g. `even-terminal`) and retry."
      );
      process.exit(1);
    }

    let chosen;
    if (instances.length === 1) {
      chosen = instances[0];
    } else {
      try {
        chosen = await promptChoice(instances);
      } catch (err) {
        console.error(`[codex] ${err.message}`);
        process.exit(1);
      }
    }

    try {
      const result = await postEnsureAppServer(chosen);
      if (!result.started) {
        console.error(
          `[codex] server reported codex app-server failed to start ` +
          `(see even-terminal logs on pid ${chosen.pid})`
        );
        process.exit(1);
      }
      codexPort = result.port ?? chosen.codexAppServerPort ?? codexPort;
    } catch (err) {
      console.error(
        `[codex] failed to signal even-terminal server pid=${chosen.pid} ` +
        `on port ${chosen.port}: ${err.message}`
      );
      process.exit(1);
    }

    if (!(await waitForPort(codexPort))) {
      console.error(`[codex] codex app-server did not become reachable on port ${codexPort} within 6s`);
      process.exit(1);
    }
  }

  const wsUrl = `ws://127.0.0.1:${codexPort}`;
  const args = hasCodexCwdArg(extraArgs)
    ? ["--remote", wsUrl, ...extraArgs]
    : ["--remote", wsUrl, "-C", cwd, ...extraArgs];
  const result = spawnSyncShim("codex", args, {
    stdio: "inherit",
    env: process.env,
    cwd,
  });
  if (result.error) {
    process.stderr.write(`even-terminal: failed to launch codex: ${result.error.message}\n`);
  }
  process.exit(result.status ?? 1);
}

function hasCodexCwdArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-C" || arg === "--cd" || arg.startsWith("--cd=")) return true;
  }
  return false;
}
