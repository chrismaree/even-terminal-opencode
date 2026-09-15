# even-terminal-opencode

Run your **opencode sessions (managed by OpenChamber) on Even Realities G2
glasses** through the official Even app Terminal Mode — including R1 ring
tap-to-approve and hold-to-talk voice instructions.

This is an adapter server that speaks even-terminal's `/api` + SSE wire
contract with an "opencode" provider backed by OpenChamber's local HTTP API.
It presents as `claude` on the wire because the Even app filters its session
list to known providers (same trick as `even-terminal-pi`).

```
Even app ◄─SSE/REST (LAN :3456)─► even-terminal-opencode ─► OpenChamber :57123
                                                                     │
                                                        opencode servers (per project)
Even app ─BLE─► G2 glasses (576×288) + R1 ring
```

## Requirements

- macOS (or Linux) with **OpenChamber** running (desktop app; provides the
  local API on `http://127.0.0.1:57123`)
- Node.js ≥ 23.6 (type-stripping; no build step)
- Even G2 + R1 ring paired through the Even app (iOS/Android)
- Phone and Mac on the same Wi-Fi (LAN). Tailscale/tunnels can be added later.

## Run

```bash
npm install
npm start
# options: --port 3456 --token <t> --name <host> --oc http://127.0.0.1:57123
```

It prints a URL + QR like:

```
http://10.10.0.59:3456?token=<token>&defaultProvider=claude
```

Open the Even app → Terminal Mode → scan the QR. Your OpenChamber sessions
appear grouped by recency; open one and it streams live.

## What works

- **Session list** across all OpenChamber projects (worktrees + sandboxes),
  with live busy/idle status
- **Live streaming**: assistant text deltas, tool start/end with summaries,
  and a final `result` when the turn finishes (driven by one upstream SSE
  connection to OpenChamber's `/api/global/event`). Tool cards are quiet by
  default: read-only tools (reads, greps, todos) are hidden and action tools
  get compact single-line summaries (`npm run build`, `app.ts +12`);
  `--verbose` restores full tool chatter
- **Permission approval**: pending opencode permissions surface as
  `permission_request`; tap the ring to allow, tap-and-hold style options for
  always-allow / deny (mapped to opencode's `once` / `always` / `reject`)
- **Voice / quick replies**: become `prompt_async` messages on the session
- **Interrupt**: stop a running turn from the glasses
- **History**: recent transcript per session

## Architecture

```
src/
  cli.ts          entry: args, banner, QR, wiring
  server.ts       bridge HTTP server (/api + SSE, auth) — even-terminal contract
  provider.ts     opencode provider: sessions, prompt, permissions, questions
  translate.ts    pure mapping: opencode events/REST -> even-terminal messages
  openchamber.ts  OpenChamber REST client (:57123)
  sse.ts          upstream SSE pump with reconnect/backoff, payload unwrap
  throttle.ts     text_delta coalescing (200ms / 2KB flush windows)
  hub.ts          per-session ring buffer (500) + SSE fan-out + heartbeat
  types.ts        even-terminal message + provider types
vendor/
  even-terminal/  MIT-licensed dist of @monsterrg/even-terminal (JSR port of
                  Even's CLI) — kept as the wire-contract reference; not imported
```

### Wire contract notes

The Even app talks to the bridge exactly as it would to Even's official
`even-terminal` server: `GET /api/sessions|info|events|messages|status`,
`POST /api/prompt|permission-response|question-response|interrupt`, with
Bearer/query token auth, SSE replay (`needReplay=true`) and 15s heartbeats.

Message types rendered by the glasses (verified against the vendored
`claude/session.js` contract): `text_delta`, `tool_start`, `tool_end`,
`status`, `permission_request`, `permission_result`, `user_question`,
`question_answer`, `result`, `notification`, `running_stats`, `task_progress`,
`error`, `user_prompt`.

### OpenChamber endpoints used

- `GET /api/session[?directory=]` — sessions (merged across project servers)
- `GET /api/session-activity` — busy/idle map
- `GET /api/session/{id}/message` — transcript/history
- `POST /api/session/{id}/prompt_async` — non-blocking prompt
- `GET /api/permission` — pending permission requests
- `POST /api/session/{id}/permission/{requestID}/reply` — `{response: once|always|reject}`
- `POST /api/session/{id}/question/{requestID}/reply|reject`
- `POST /api/session/{id}/interrupt`
- `GET /api/global/event` — SSE event stream for all servers

## Performance

- One upstream SSE connection shared by all clients; fan-out is in-process
- Streaming rides opencode's incremental `message.part.delta` events
  (with `message.part.updated` as fallback), translated in real time
- Leading-edge delta coalescing: first delta of a burst flushes instantly,
  the rest batches (~200 ms / 2 KB windows)
- Permissions and questions are event-driven (`permission.asked`,
  `question.asked`, `*replied`/`*rejected`) — REST snapshots
  (`/api/permission`, `/api/question`) are only a fallback, refreshed on
  every (re)connect and every 30 s
- Per-session ring buffers capped at 500 messages; translator state pruned;
  tool outputs in `tool_end` trimmed to 500 chars
- Reconnects use exponential backoff (500 ms → 30 s, ±20 % jitter) and
  resync state immediately on reconnect

## Tests

```bash
npm test        # node --test (29 tests: translation, mapping, backoff,
                # coalescing, and a full HTTP/SSE round-trip against a stub)
npm run typecheck
```

## Known limitations

- Questions (opencode ask-user) surface via `question.asked` events and the
  `GET /api/question` snapshot; answers go to
  `/api/session/{id}/question/{requestID}/reply`. Voice/quick answers also
  always work as plain prompts.
- Presenting as provider `claude` is cosmetic; the model shown in the app
  comes from the most recent session's model.
- LAN-only for now; add Tailscale by pointing the Even app at the tailnet IP.

## License

MIT — see [LICENSE](LICENSE). The vendored `vendor/even-terminal/` code is the
MIT-licensed Deno/JSR port of Even Realities' `@evenrealities/even-terminal`
(see `vendor/even-terminal/LICENSE`), kept as the wire-contract reference.

## Credits

- [Even Realities](https://www.evenrealities.com/) for the G2/R1 and the
  even-terminal protocol
- the Deno/JSR port of even-terminal (MIT) whose vendored dist pins the wire
  contract
- the OpenChamber + opencode projects this bridge is built on
