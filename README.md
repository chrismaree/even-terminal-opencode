# even-terminal-opencode

Run your **opencode sessions (managed by OpenChamber) on Even Realities G2
glasses** through the official Even app Terminal Mode — including R1 ring
tap-to-approve and hold-to-talk voice instructions.

This is an adapter server that speaks even-terminal's `/api` + SSE wire
contract with an "opencode" provider backed by the **OpenCode v2 HTTP API**,
as served by OpenChamber (or directly by an opencode server).
It presents as `claude` on the wire because the Even app filters its session
list to known providers (same trick as `even-terminal-pi`).

```
Even app ◄─SSE/REST (LAN/Tailscale :3456)─► even-terminal-opencode ─► OpenChamber :57123
                                                                          │ (/api/* v2 proxy)
                                                                     opencode server
Even app ─BLE─► G2 glasses (576×288) + R1 ring
```

## Requirements

- macOS (or Linux) with **OpenChamber ≥ 2.0** running (desktop app; provides
  the OpenCode v2 API on `http://127.0.0.1:57123`), or any opencode **v2**
  server. Verified against OpenChamber 2.0.4 / opencode 2.0.20. OpenChamber
  1.x / opencode v1 are no longer supported.
- Node.js ≥ 23.6 (type-stripping; no build step)
- Even G2 + R1 ring paired through the Even app (iOS/Android)
- Phone able to reach the bridge: same Wi-Fi, or both on the same Tailscale
  tailnet

## Run

```bash
npm install
npm start
# options: --port 3456 --bind <addr> --advertise <host> --token <t>
#          --name <host> --oc http://127.0.0.1:57123
```

It prints a URL + QR like:

```
http://10.10.0.59:3456?token=<token>&defaultProvider=claude
```

Open the Even app → Terminal Mode → scan the QR. Your OpenChamber sessions
appear grouped by recency; open one and it streams live.

### Over Tailscale / multiple hosts

Run one bridge per OpenChamber host, next to it, and pair each one in the Even
app under a different `--name`. Bind to the tailnet only and advertise a
MagicDNS name so the QR works from anywhere on your tailnet:

```bash
BRIDGE_TOKEN=<long-random> npm start -- \
  --bind "$(tailscale ip -4)" --advertise my-mac.tailnet-name.ts.net --name mac
```

`BRIDGE_TOKEN` keeps the pairing stable across restarts. To point the bridge
at a password-protected opencode server instead of a local OpenChamber, pass
`--oc <url>` and set `OC_PASSWORD` (and `OC_USERNAME`, default `opencode`) in
the environment; the bridge then sends HTTP basic auth on every request and
on the event stream.

## What works

- **Session list** across every location (v2 lists sessions globally),
  labelled by project, with live busy/idle status
- **Live streaming**: assistant text deltas, thinking indicator, tool
  start/end with summaries, and a final `result` when the turn finishes
  (driven by one upstream SSE connection to the v2 `/api/event` stream). Tool
  cards are quiet by default: read-only tools (reads, greps, todos, skills)
  are hidden and action tools get compact single-line summaries
  (`npm run build`, `app.ts +12`); `--verbose` restores full tool chatter
- **Permission approval**: pending opencode permissions surface as
  `permission_request`; tap the ring to allow, tap-and-hold style options for
  always-allow / deny (mapped to opencode's `once` / `always` / `reject`)
- **Questions**: opencode v2 ask-user forms surface as `user_question`;
  answers map option labels back to form values (`skip` cancels the form)
- **Voice / quick replies**: become prompts on the session (v2 inbox)
- **Interrupt**: stop a running turn from the glasses
- **History**: recent transcript per session

## Architecture

```
src/
  cli.ts          entry: args, banner, QR, wiring
  server.ts       bridge HTTP server (/api + SSE, auth) — even-terminal contract
  provider.ts     opencode provider: sessions, prompt, permissions, questions
  translate.ts    pure mapping: opencode events/REST -> even-terminal messages
  openchamber.ts  OpenCode v2 REST client (OpenChamber :57123 or opencode)
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

### OpenCode v2 endpoints used

- `GET /api/session?parentID=null&order=desc` — root sessions (all locations)
- `GET /api/session/{id}`, `POST /api/session` — lookup / create
- `GET /api/session/active` — running sessions
- `GET /api/location`, `GET /api/project` — default location + project labels
- `GET /api/session/{id}/message` — transcript/history
- `POST /api/session/{id}/prompt` — non-blocking prompt (`{text}`)
- `POST /api/session/{id}/interrupt`
- `GET /api/permission/request?location[directory]=` — pending permissions
- `POST /api/session/{id}/permission/{requestID}/reply` — `{decision: once|always|reject}`
- `GET /api/form?location[directory]=` — pending ask-user forms
- `POST /api/session/{id}/form/{formID}/reply` — `{answer: {fieldKey: value}}`;
  `DELETE /api/session/{id}/form/{formID}` to cancel
- `GET /api/event` — v2 SSE event stream for all locations

## Performance

- One upstream SSE connection shared by all clients; fan-out is in-process
- Streaming rides opencode's `session.text.delta` events, translated in real
  time; `session.text.ended` fills in anything missed while reconnecting
- Leading-edge delta coalescing: first delta of a burst flushes instantly,
  the rest batches (~200 ms / 2 KB windows)
- Permissions and questions are event-driven (`permission.asked`,
  `form.created`, `permission.replied`, `form.replied|cancelled`) — REST
  snapshots of the most recently active locations are only a fallback,
  refreshed on every (re)connect and every 30 s
- Per-session ring buffers capped at 500 messages; translator state pruned;
  tool output in verbose `tool_end` detail trimmed to 200 chars
- Reconnects use exponential backoff (500 ms → 30 s, ±20 % jitter) and
  resync state immediately on reconnect

## Tests

```bash
npm test        # node --test (72 tests: v2 translation, mapping, backoff,
                # coalescing, and a full HTTP/SSE round-trip against a v2 stub)
npm run typecheck
```

## Known limitations

- Ask-user forms with several fields are answered from one glasses reply;
  free-text and multiselect fields take the spoken/typed answer as-is
  (multiselect splits on commas). External (link) fields are skipped.
- Presenting as provider `claude` is cosmetic; the model shown in the app
  comes from the most recent session's model.
- Project aliases come from the local `~/.config/openchamber/settings.json`;
  against a remote server, labels fall back to folder names.
- The bridge serves plain HTTP with the token in the pairing URL — keep it on
  your LAN or tailnet (`--bind`), never expose it publicly. Request logs
  redact the token.

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
