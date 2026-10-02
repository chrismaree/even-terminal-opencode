#!/usr/bin/env node
// even-terminal-opencode — opencode sessions (via OpenChamber) on Even G2 glasses.

import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { MessageHub } from "./hub.ts";
import { OpenChamberClient } from "./openchamber.ts";
import { createOpencodeProvider, PROVIDER_NAME } from "./provider.ts";
import { createBridgeServer } from "./server.ts";

interface CliOpts {
  port: number;
  bind: string;
  advertise: string;
  token: string;
  name: string;
  ocBase: string;
  ocUser: string;
  ocPassword: string;
  prefixTitles: boolean;
  verbose: boolean;
  newSessionDir: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    port: Number(process.env.PORT ?? "3456"),
    bind: process.env.BIND ?? "0.0.0.0",
    advertise: process.env.ADVERTISE_HOST ?? "",
    token: process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex"),
    name: process.env.EVEN_TERMINAL_NAME ?? "",
    ocBase: process.env.OC_BASE ?? "http://127.0.0.1:57123",
    ocUser: process.env.OC_USERNAME ?? "opencode",
    ocPassword: process.env.OC_PASSWORD ?? "",
    prefixTitles: process.env.NO_PREFIX !== "1",
    verbose: process.env.VERBOSE === "1",
    newSessionDir: process.env.NEW_SESSION_DIR ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const take = (set: (v: string) => void) => {
      if (next) set(next);
      i++;
    };
    switch (arg) {
      case "-p":
      case "--port":
        take((v) => (opts.port = Number(v)));
        break;
      case "--bind":
        take((v) => (opts.bind = v));
        break;
      case "--advertise":
        take((v) => (opts.advertise = v));
        break;
      case "-t":
      case "--token":
        take((v) => (opts.token = v));
        break;
      case "-n":
      case "--name":
        take((v) => (opts.name = v));
        break;
      case "--oc":
        take((v) => (opts.ocBase = v));
        break;
      case "--oc-user":
        take((v) => (opts.ocUser = v));
        break;
      case "--no-prefix":
        opts.prefixTitles = false;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--new-session-dir":
        take((v) => (opts.newSessionDir = v));
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`even-terminal-opencode — opencode sessions on Even G2 glasses

Usage: even-terminal-opencode [options]

  -p, --port <n>        bridge port (default 3456)
      --bind <addr>     listen address (default 0.0.0.0; e.g. your Tailscale IP)
      --advertise <h>   host put in the pairing URL/QR (e.g. a Tailscale
                        MagicDNS name); default: first LAN IPv4
  -t, --token <str>     auth token (default: random per run; set BRIDGE_TOKEN
                        to keep pairing stable across restarts)
  -n, --name <str>      host name shown in the Even app
      --oc <url>        OpenCode v2 API base: OpenChamber (default
                        http://127.0.0.1:57123) or an opencode server
      --oc-user <u>     basic-auth user for --oc (default "opencode")
      --no-prefix       do not prefix session titles with the project label
      --new-session-dir <path>  where new glasses sessions are created
                        (default: the server's default location)
      --verbose         show tool cards for read-only tools (reads, greps) too
  -h, --help            show this help

Env: PORT, BIND, ADVERTISE_HOST, BRIDGE_TOKEN, EVEN_TERMINAL_NAME, OC_BASE,
     OC_USERNAME, OC_PASSWORD (basic auth for --oc; env only), NEW_SESSION_DIR,
     NO_PREFIX=1, VERBOSE=1`);
}

function lanAddress(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return undefined;
}

process.on("uncaughtException", (err: Error) => {
  console.error(`[bridge] uncaught exception: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[bridge] unhandled rejection: ${(reason as Error)?.stack ?? reason}`);
});

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const hub = new MessageHub();
  const authorization = opts.ocPassword
    ? `Basic ${Buffer.from(`${opts.ocUser}:${opts.ocPassword}`).toString("base64")}`
    : undefined;
  const oc = new OpenChamberClient(opts.ocBase, { authorization });
  const log = (line: string) => console.log(line);
  const provider = createOpencodeProvider({
    oc,
    hub,
    eventUrl: `${oc.base}/api/event`,
    hostLabel: opts.name,
    prefixTitles: opts.prefixTitles,
    newSessionDir: opts.newSessionDir || undefined,
    verboseTools: opts.verbose,
    log,
  });

  const server = createBridgeServer({ provider, hub, token: opts.token, log });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.bind, resolve));
  provider.start();

  // fail fast when the OpenCode API isn't reachable
  try {
    const sessions = await oc.listSessions(1);
    if (sessions.length === 0) console.warn(`[warn] ${oc.base} returned no sessions`);
  } catch (err) {
    console.warn(`[warn] OpenCode API not reachable at ${oc.base}: ${(err as Error).message}`);
    console.warn("[warn] start OpenChamber, or pass --oc <url> (and OC_PASSWORD if protected)");
  }

  const lan = lanAddress();
  const host = opts.advertise || (opts.bind !== "0.0.0.0" ? opts.bind : lan) || "127.0.0.1";
  const params = new URLSearchParams({ token: opts.token, defaultProvider: PROVIDER_NAME });
  if (opts.name) params.set("name", opts.name);
  const pairUrl = `http://${host}:${opts.port}?${params.toString()}`;

  const pad = (label: string) => label.padEnd(7);
  console.log("");
  console.log(`  even-terminal-opencode — opencode on Even G2`);
  console.log(`  ${pad("Listen")}http://${opts.bind}:${opts.port}`);
  console.log(`  ${pad("Pair")}http://${host}:${opts.port}`);
  console.log(`  ${pad("OpenCo")}${oc.base}${authorization ? " (basic auth)" : ""}`);
  console.log(`  ${pad("Token")}${opts.token.slice(0, 8)}...${opts.token.slice(-4)}`);
  console.log("");
  console.log("  Scan with the Even app (Terminal Mode):");
  try {
    const { default: qrcode } = await import("qrcode-terminal");
    qrcode.generate(pairUrl, { small: true });
  } catch {
    // QR is optional; the URL below is enough
  }
  console.log(`  ${pairUrl}`);
  console.log("");
}

main().catch((err: Error) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
