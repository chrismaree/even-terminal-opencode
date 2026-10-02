import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, connectUpstream, createSseParser, parseUpstreamEvent } from "../src/sse.ts";
import type { UpstreamEvent } from "../src/sse.ts";

test("backoffDelay grows exponentially, caps at 30s, jitters +-20%", () => {
  const deterministic = (p: number) => () => p; // 0 -> 0.8x, 0.5 -> 1.0x, 1 -> 1.2x
  assert.equal(backoffDelay(0, deterministic(0.5)), 500);
  assert.equal(backoffDelay(1, deterministic(0.5)), 1000);
  assert.equal(backoffDelay(2, deterministic(0.5)), 2000);
  assert.equal(backoffDelay(6, deterministic(0.5)), 30_000);
  assert.equal(backoffDelay(20, deterministic(0)), 24_000); // 30s * 0.8
  assert.equal(backoffDelay(20, deterministic(1)), 36_000); // 30s * 1.2
});

test("createSseParser extracts data payloads across chunk boundaries", () => {
  const seen: string[] = [];
  const parser = createSseParser((d) => seen.push(d));
  parser.push('data: {"a":1}\n\ndata: {"b":');
  parser.push('2}\n\n:heartbeat\n\nid: 7\nevent: x\ndata: line1\ndata: line2\n\n');
  parser.push('data: {"crlf":true}\r\n\r\n');
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', "line1\nline2", '{"crlf":true}']);
});

test("parseUpstreamEvent maps v2 bus events {id,type,location,data}", () => {
  const v2 = parseUpstreamEvent(
    JSON.stringify({
      id: "evt1",
      type: "session.text.delta",
      location: { directory: "/tmp/project" },
      data: { sessionID: "s", delta: "hi" },
    }),
  );
  assert.deepEqual(v2, {
    id: "evt1",
    type: "session.text.delta",
    data: { sessionID: "s", delta: "hi" },
    directory: "/tmp/project",
  });

  // no location / no data -> undefined directory, empty data
  assert.deepEqual(parseUpstreamEvent(JSON.stringify({ type: "session.idle" })), {
    id: undefined,
    type: "session.idle",
    data: {},
    directory: undefined,
  });
});

test("parseUpstreamEvent tolerates payload envelopes and legacy properties, ignores junk", () => {
  const wrapped = parseUpstreamEvent(
    JSON.stringify({ payload: { id: "evt2", type: "session.idle", location: { directory: "/d" }, data: { sessionID: "s" } } }),
  );
  assert.equal(wrapped?.type, "session.idle");
  assert.equal(wrapped?.data.sessionID, "s");
  assert.equal(wrapped?.directory, "/d");

  const legacy = parseUpstreamEvent(JSON.stringify({ type: "session.idle", properties: { sessionID: "s2" } }));
  assert.equal(legacy?.data.sessionID, "s2");

  assert.equal(parseUpstreamEvent("not json"), null);
  assert.equal(parseUpstreamEvent("null"), null);
  assert.equal(parseUpstreamEvent('"string"'), null);
  assert.equal(parseUpstreamEvent(JSON.stringify({ noType: true })), null);
  assert.equal(parseUpstreamEvent('{"type":123}'), null);
});

test("connectUpstream reconnects with backoff and dispatches events", async () => {
  const received: UpstreamEvent[] = [];
  const disconnects: string[] = [];
  let connected = 0;
  let connections = 0;
  const sleeps: number[] = [];

  // A stub fetch that serves one SSE response that dies, then a healthy one
  const ac = new AbortController();
  const fetchImpl = (async () => {
    const call = connections++;
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        if (call === 0) {
          controller.enqueue(encoder.encode('data: {"type":"e1","data":{"sessionID":"s"}}\n\n'));
          // one bad event and one handler-throwing event must not kill the stream
          controller.enqueue(encoder.encode("data: garbage\n\n"));
          controller.enqueue(encoder.encode('data: {"type":"throw","data":{}}\n\n'));
          setTimeout(() => controller.error(new Error("boom")), 5);
        } else {
          controller.enqueue(encoder.encode('data: {"type":"e2","data":{}}\n\n'));
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  connectUpstream({
    url: "http://stub/api/event",
    fetchImpl,
    onEvent: (e) => {
      received.push(e);
      if (e.type === "throw") throw new Error("handler failure");
    },
    onConnected: () => connected++,
    onDisconnected: (reason) => disconnects.push(reason ?? ""),
    signal: ac.signal,
    rand: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const deadline = Date.now() + 3000;
  while (!received.some((e) => e.type === "e2") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ac.abort();
  assert.deepEqual(
    received.map((e) => e.type),
    ["e1", "throw", "e2"],
  );
  assert.equal(received[0]!.data.sessionID, "s");
  assert.equal(connections, 2);
  assert.equal(connected, 2);
  assert.deepEqual(disconnects, ["boom"]);
  assert.deepEqual(sleeps, [500]); // first backoff, attempt reset after reconnect
});

test("connectUpstream backs off on HTTP errors with growing delays", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const disconnects: string[] = [];
  const ac = new AbortController();
  const fetchImpl = (async () => {
    calls++;
    return new Response("nope", { status: 503 });
  }) as unknown as typeof fetch;

  connectUpstream({
    url: "http://stub/api/event",
    fetchImpl,
    onEvent: () => undefined,
    onDisconnected: (reason) => disconnects.push(reason ?? ""),
    signal: ac.signal,
    rand: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) ac.abort();
    },
  });

  const deadline = Date.now() + 2000;
  while (sleeps.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  assert.equal(calls, 3);
  assert.deepEqual(disconnects, ["upstream HTTP 503", "upstream HTTP 503", "upstream HTTP 503"]);
});

test("connectUpstream sends Accept plus custom headers and stops on abort", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, signal: init.signal });
    // a stream that never ends until aborted
    return new Response(new ReadableStream({ start() {} }), { status: 200 });
  }) as unknown as typeof fetch;

  const upstream = connectUpstream({
    url: "http://stub/api/event",
    headers: { Authorization: "Basic abc" },
    fetchImpl,
    onEvent: () => undefined,
  });
  await new Promise((r) => setTimeout(r, 20));
  upstream.abort();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "http://stub/api/event");
  assert.deepEqual(seen[0]!.headers, { Accept: "text/event-stream", Authorization: "Basic abc" });
  assert.equal(seen[0]!.signal?.aborted, true);
});
