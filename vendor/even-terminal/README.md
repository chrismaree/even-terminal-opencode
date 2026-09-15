# @monsterrg/even-terminal

A **Deno/JSR port** of Even Realities' [`even-terminal`](https://www.npmjs.com/package/@evenrealities/even-terminal)
(MIT). even-terminal runs a local HTTP/SSE bridge on `:3456` that mirrors an AI
coding agent (Claude Code / Codex) onto **Even Realities G2 glasses** and routes
**R1 ring** gestures back as input. The phone (Even app) reaches your laptop over
LAN / Tailscale / a tunnel; phone ↔ glasses is BLE.

Upstream has no public source repo, so its npm source is vendored under `dist/`
essentially unmodified. Two deliberate changes make it embeddable:

1. **`startServer(opts)`** (`dist/index.js`) — upstream started on `import`; here
   it's an explicit call so an embedder can register providers first.
2. **`registerProvider(name, factory)`** (`dist/routes/core.js`) — upstream
   hardcoded `{ claude, codex }`. Now a host app can inject its own provider
   (e.g. a **box** provider that lists sandboxed Claude sessions **by project**
   and drives each live) without forking the request/rendering layer.

Everything else — pairing/QR/token, the SSE message schema the glasses render,
the claude/codex providers, tunnels — is upstream behavior.

## Run the CLI (unchanged UX)

```bash
deno task start                 # even-terminal start, port 3456
deno run -A bin/cli.js --help
```

## Embed + add a custom provider

```ts
import { startServer, registerProvider } from "@monsterrg/even-terminal";

// factory(emit) returns the provider handler object; emit(sessionId, msg)
// streams a typed message to the glasses over SSE.
registerProvider("box", (emit) => createBoxProvider(emit));

await startServer({ defaultProvider: "box", token: "my-fixed-token" });
```

Provider interface: `listSessions, getSessionStatus, getInfo, getHistory,
prompt, respondPermission, respondQuestion, interrupt, getStatus` (see
`mod.ts`).

## Attribution

Original © Even Realities (MIT). Deno/JSR port © 2026 monsterrg. See `LICENSE`.
