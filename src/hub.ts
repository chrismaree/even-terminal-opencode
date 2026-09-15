// Per-session message ring buffer + SSE client fan-out.
// Mirrors vendor/even-terminal/dist/routes/events.js (MAX 500, replay, 15s heartbeat).

import type { EvenMessage } from "./types.ts";

const MAX_MESSAGES_PER_SESSION = 500;

interface SessionBucket {
  messages: Array<{ id: number; msg: EvenMessage }>;
  clients: Set<import("node:http").ServerResponse>;
  nextId: number;
  /** id of the user_prompt/busy that opened the current turn (kept on trim) */
  activeTurnStartId: number | null;
}

export class MessageHub {
  private sessions = new Map<string, SessionBucket>();

  private get(sessionId: string): SessionBucket {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { messages: [], clients: new Set(), nextId: 1, activeTurnStartId: null };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  pushMessage(sessionId: string, msg: EvenMessage): number {
    const s = this.get(sessionId);
    const id = s.nextId++;
    s.messages.push({ id, msg });
    if (msg.type === "user_prompt" && s.activeTurnStartId === null) s.activeTurnStartId = id;
    if (msg.type === "status" && msg.state === "busy" && s.activeTurnStartId === null) {
      s.activeTurnStartId = id;
    }
    if (msg.type === "status" && msg.state === "idle") s.activeTurnStartId = null;
    // Keep the active turn intact so a mid-turn client can replay its user prompt.
    const retainFrom = Math.min(id - MAX_MESSAGES_PER_SESSION + 1, s.activeTurnStartId ?? Infinity);
    if (s.messages.length > 0 && s.messages[0]!.id < retainFrom) {
      const removeCount = s.messages.findIndex((m) => m.id >= retainFrom);
      if (removeCount > 0) s.messages.splice(0, removeCount);
     }
    return id;
  }

  getMessages(sessionId: string, after: number): Array<{ id: number } & EvenMessage> {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }));
  }

  /** Replay+subscribe; returns a disposer for the client. */
  subscribe(
    sessionId: string,
    res: import("node:http").ServerResponse,
    opts: { needReplay?: boolean } = {},
    heartbeatMs = 15_000,
  ): { dispose: () => void } {
    const s = this.get(sessionId);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");
    if (opts.needReplay) {
      for (const entry of s.messages) {
        res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
      }
    }
    s.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, heartbeatMs);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      s.clients.delete(res);
    };
    res.on("close", dispose);
    return { dispose };
  }

  broadcast(sessionId: string, msg: EvenMessage, id: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const res of s.clients) {
      try {
        res.write(`id: ${id}\ndata: ${data}\n\n`);
      } catch {
        s.clients.delete(res);
      }
    }
  }

  /** push + broadcast in one step; returns the message id. */
  emit(sessionId: string, msg: EvenMessage): number {
    const id = this.pushMessage(sessionId, msg);
    this.broadcast(sessionId, msg, id);
    return id;
  }

  clientCount(): number {
    let total = 0;
    for (const s of this.sessions.values()) total += s.clients.size;
    return total;
  }
}
