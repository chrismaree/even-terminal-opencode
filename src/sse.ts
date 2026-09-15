// Upstream SSE connection to OpenChamber with reconnect + backoff,
// plus a pure SSE parser for tests.

export interface UpstreamEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
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
      buffer += chunk;
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

/** Normalizes an SSE data payload into an UpstreamEvent (or null to ignore). */
export function parseUpstreamData(payload: string): UpstreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  // /api/global/event wraps the bus event in { payload: {...} }
  const inner = typeof obj.payload === "object" && obj.payload !== null ? obj.payload : obj;
  const ev = inner as Record<string, unknown>;
  if (typeof ev.type !== "string") return null;
  return {
    id: typeof ev.id === "string" ? ev.id : undefined,
    type: ev.type,
    properties: (ev.properties ?? {}) as Record<string, unknown>,
  };
}

interface SseController {
  abort(): void;
}

interface SseDeps {
  url: string;
  fetchImpl?: typeof fetch;
  onEvent: UpstreamHandler;
  onConnected?: () => void;
  onDisconnected?: () => void;
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
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`upstream HTTP ${res.status}`);
        attempt = 0;
        deps.onConnected?.();
        const parser = createSseParser((data) => {
          const event = parseUpstreamEvent(data);
          if (event) deps.onEvent(event);
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        deps.onDisconnected?.();
      } catch {
        deps.onDisconnected?.();
      }
      if (signal.aborted) return;
      await sleep(backoffDelay(attempt++, rand));
    }
  })();

  return { abort: () => ac.abort() };
}

export function parseUpstreamEvent(payload: string): UpstreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const inner = typeof obj.payload === "object" && obj.payload !== null ? obj.payload : obj;
  const ev = inner as Record<string, unknown>;
  if (typeof ev.type !== "string") return null;
  return {
    id: typeof ev.id === "string" ? ev.id : undefined,
    type: ev.type,
    properties: (ev.properties ?? {}) as Record<string, unknown>,
  };
}
