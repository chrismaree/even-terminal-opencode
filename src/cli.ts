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
  token: string;
  name: string;
  ocBase: string;
  prefixTitles: boolean;
  verbose: boolean;
  newSessionDir: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    port: Number(process.env.PORT ?? "3456"),
    token: process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex"),
    name: process.env.EVEN_TERMINAL_NAME ?? "",
    ocBase: process.env.OC_BASE ?? "http://127.0.0.1:57123",
    prefixTitles: process.env.NO_PREFIX !== "1",
    verbose: process.env.VERBOSE === "1",
    newSessionDir: process.env.NEW_SESSION_DIR ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "-p":
      case "--port":
        if (next) opts.port = Number(next);
        i++;
        break;
      case "-t":
      case "--token":
        if (next) opts.token = next;
        i++;
        break;
      case "-n":
      case "--name":
        if (next) opts.name = next;
        i++;
        break;
      case "--oc":
        if (next) opts.ocBase = next;
        i++;
        break;
      case "--no-prefix":
        opts.prefixTitles = false;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--new-session-dir":
        if (next) opts.newSessionDir = next;
        i++;
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

  -p, --port <n>      bridge port (default 3456)
  -t, --token <str>   auth token (default: random per run)
  -n, --name <str>    host name shown in the Even app
      --oc <url>      OpenChamber base URL (default http://127.0.0.1:57123)
      --no-prefix     do not prefix session titles with the project label
      --new-session-dir <path>  where new glasses sessions are created
                      (default: your most recently active project)
      --verbose       show tool cards for read-only tools (reads, greps) too
  -h, --help          show this help

Env: PORT, BRIDGE_TOKEN, EVEN_TERMINAL_NAME, OC_BASE, NO_PREFIX=1`);
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
  const oc = new OpenChamberClient(opts.ocBase);
  const provider = createOpencodeProvider({
    oc,
    hub,
    eventUrl: `${opts.ocBase}/api/global/event`,
    hostLabel: opts.name,
    prefixTitles: opts.prefixTitles,
    newSessionDir: opts.newSessionDir || undefined,
  });

  const server = createBridgeServer({ provider, hub, token: opts.token });
  await new Promise<void>((resolve) => server.listen(opts.port, "0.0.0.0", resolve));
  provider.start();

  // fail fast when OpenChamber isn't running
  try {
    await oc.listProjects();
  } catch (err) {
    console.warn(`[warn] OpenChamber not reachable at ${opts.ocBase}: ${(err as Error).message}`);
    console.warn("[warn] start OpenChamber, or pass --oc <url>");
  }

  const lan = lanAddress();
  const params = new URLSearchParams({ token: opts.token, defaultProvider: PROVIDER_NAME });
  if (opts.name) params.set("name", opts.name);
  const pairUrl = `http://${lan ?? "127.0.0.1"}:${opts.port}?${params.toString()}`;

  const pad = (label: string) => label.padEnd(7);
  console.log("");
  console.log(`  even-terminal-opencode — opencode on Even G2`);
  console.log(`  ${pad("Local")}http://localhost:${opts.port}`);
  if (lan) console.log(`  ${pad("LAN")}http://${lan}:${opts.port}`);
  console.log(`  ${pad("OpenCh")}${opts.ocBase}`);
  console.log(`  ${pad("Token")}${opts.token.slice(0, 8)}...${opts.token.slice(-4)}`);
  console.log("");
  console.log("  Scan with the Even app (Terminal Mode):");
  try {
    const { default: qrcode } = await import("qrcode-terminal");
    qrcode.generate(pairUrl, { small: true });
  } catch {
    console.log(`  ${pairUrl}`);
  }
  console.log(`  ${pairUrl}`);
  console.log("");
}

main().catch((err: Error) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
