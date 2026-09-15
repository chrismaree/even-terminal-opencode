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
  parser.push('2}\n\n:heartbeat\n\ndata: line1\ndata: line2\n\n');
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', "line1\nline2"]);
});

test("parseUpstreamEvent unwraps /api/global/event payloads and ignores junk", () => {
  const wrapped = parseUpstreamEvent(
    JSON.stringify({ payload: { id: "evt1", type: "session.status", properties: { sessionID: "s" } } }),
  );
  assert.equal(wrapped?.type, "session.status");
  assert.equal(wrapped?.properties.sessionID, "s");

  const flat = parseUpstreamEvent(JSON.stringify({ id: "evt2", type: "message.part.updated", properties: {} }));
  assert.equal(flat?.type, "message.part.updated");

  assert.equal(parseUpstreamEvent("not json"), null);
  assert.equal(parseUpstreamEvent(JSON.stringify({ noType: true })), null);
  assert.equal(parseUpstreamEvent('{"type":123}'), null);
});

test("connectUpstream reconnects with backoff and dispatches events", async () => {
  const received: UpstreamEvent[] = [];
  let connections = 0;
  const sleeps: number[] = [];

  // A stub fetch that serves two SSE responses then hangs (aborted via controller)
  const ac = new AbortController();
  let call = 0;
  const fetchImpl = (async () => {
    connections++;
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        if (call === 0) {
          controller.enqueue(encoder.encode('data: {"type":"e1","properties":{}}\n\n'));
          call++;
          // then die
          setTimeout(() => controller.error(new Error("boom")), 5);
        } else {
          controller.enqueue(encoder.encode('data: {"type":"e2","properties":{}}\n\n'));
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  const upstream = connectUpstream({
    url: "http://stub/api/global/event",
    fetchImpl,
    onEvent: (e) => received.push(e),
    signal: ac.signal,
    rand: () => 0.5,
  });
  void upstream;

  // second connection happens after the first backoff (~500ms)
  const deadline = Date.now() + 3000;
  while (!received.some((e) => e.type === "e2") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  ac.abort();
  assert.deepEqual(
    received.map((e) => e.type),
    ["e1", "e2"],
  );
  assert.equal(connections, 2);
  assert.ok(backoffDelay(0, () => 0.5) >= 400 && backoffDelay(0, () => 0.5) <= 600);
});
