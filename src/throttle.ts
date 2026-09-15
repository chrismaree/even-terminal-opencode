// Coalesces rapid text_delta emissions per session to keep the SSE stream
// (and the phone -> BLE hop) cheap. Flushes on: max delay, max chars, or
// an explicit flush (e.g. before a non-delta message must be ordered).

export interface DeltaCoalescerOptions {
  /** max ms to hold deltas before flushing */
  flushMs?: number;
  /** max buffered chars before an early flush */
  maxChars?: number;
  /** injectable timer for tests */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
}

export class DeltaCoalescer {
  private buffer = new Map<string, string>();
  private timers = new Map<string, unknown>();
  private readonly flushMs: number;
  private readonly maxChars: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  private readonly onFlush: (sessionId: string, text: string) => void;

  constructor(
    onFlush: (sessionId: string, text: string) => void,
    opts: DeltaCoalescerOptions = {},
  ) {
    this.onFlush = onFlush;
    this.flushMs = opts.flushMs ?? 200;
    this.maxChars = opts.maxChars ?? 2000;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Buffer a delta for the session. First delta of a burst flushes
   *  immediately (leading edge); subsequent ones batch until the window ends. */
  push(sessionId: string, text: string): void {
    if (!text) return;
    const buffered = this.buffer.get(sessionId);
    if (buffered === undefined && !this.timers.has(sessionId)) {
      // leading edge: emit instantly, then open a batch window
      this.onFlush(sessionId, text);
      this.timers.set(
        sessionId,
        this.schedule(() => {
          this.timers.delete(sessionId);
          this.flush(sessionId);
        }, this.flushMs),
      );
      return;
    }
    const merged = (buffered ?? "") + text;
    if (merged.length >= this.maxChars) {
      this.buffer.set(sessionId, merged);
      this.flush(sessionId);
      return;
    }
    this.buffer.set(sessionId, merged);
    if (!this.timers.has(sessionId)) {
      const timer = this.schedule(() => {
        this.timers.delete(sessionId);
        this.flush(sessionId);
      }, this.flushMs);
      this.timers.set(sessionId, timer);
    }
  }

  /** Emit buffered text for the session now (also cancels its timer). */
  flush(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      this.cancel(timer);
      this.timers.delete(sessionId);
    }
    const text = this.buffer.get(sessionId);
    if (!text) return;
    this.buffer.delete(sessionId);
    this.onFlush(sessionId, text);
  }

  /** Drop everything (e.g. when the app disconnects). */
  clear(): void {
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.buffer.clear();
  }
}
