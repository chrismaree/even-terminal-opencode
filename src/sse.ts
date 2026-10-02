// Upstream SSE connection to the opencode v2 event stream (via OpenChamber)
// with reconnect + backoff, plus a pure SSE parser for tests.

/** One opencode v2 bus event: `{ id, type, location?, data }`. */
export interface UpstreamEvent {
  id?: string;
  type: string;
  data: Record<string, unknown>;
  /** event location (`location.directory`), when the event carries one */
  directory?: string;
}

export type UpstreamHandler = (event: UpstreamEvent) => void;

/** Exponential backoff schedule: 500ms -> max 30s, +-20% jitter. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** attempt, 30_000);
  const jitter = 0.8 + rand() * 0.4; // 80%..120%
  return Math.round(base * jitter);
}

/** Incremental SSE parser: feed chunks, get `data:` payloads per event. */
export function createSseParser(onData: (data: string) => void): {
  push: (chunk: string) => void;
} {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length > 0) onData(dataLines.join("\n"));
      }
    },
  };
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Normalizes an SSE data payload into an UpstreamEvent (or null to ignore). */
export function parseUpstreamEvent(payload: string): UpstreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  // tolerate a `{ payload: {...} }` envelope (OpenChamber global stream variants)
  const ev = typeof obj.payload === "object" && obj.payload !== null ? rec(obj.payload) : obj;
  if (typeof ev.type !== "string") return null;
  const directory = rec(ev.location).directory;
  return {
    id: typeof ev.id === "string" ? ev.id : undefined,
    type: ev.type,
    data: rec(ev.data ?? ev.properties),
    directory: typeof directory === "string" ? directory : undefined,
  };
}

interface SseController {
  abort(): void;
}

interface SseDeps {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  onEvent: UpstreamHandler;
  onConnected?: () => void;
  onDisconnected?: (reason?: string) => void;
  signal?: AbortSignal;
  rand?: () => number;
  /** injectable sleep for tests (defaults to real timers) */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Opens the upstream event stream and keeps it alive with reconnects.
 * Events are dispatched synchronously; parsing failures are skipped.
 */
export function connectUpstream(deps: SseDeps): SseController {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rand = deps.rand ?? Math.random;
  const ac = new AbortController();
  const signal = deps.signal ? AbortSignal.any([ac.signal, deps.signal]) : ac.signal;
  let attempt = 0;

  void (async () => {
    while (!signal.aborted) {
      try {
        const res = await fetchImpl(deps.url, {
          signal,
          headers: { Accept: "text/event-stream", ...deps.headers },
        });
        if (!res.ok || !res.body) throw new Error(`upstream HTTP ${res.status}`);
        attempt = 0;
        deps.onConnected?.();
        const parser = createSseParser((data) => {
          const event = parseUpstreamEvent(data);
          if (!event) return;
          try {
            deps.onEvent(event);
          } catch {
            // one bad event must never kill the stream
          }
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        deps.onDisconnected?.("stream ended");
      } catch (err) {
        if (!signal.aborted) deps.onDisconnected?.((err as Error).message);
      }
      if (signal.aborted) return;
      await sleep(backoffDelay(attempt++, rand));
    }
  })();

  return { abort: () => ac.abort() };
}
