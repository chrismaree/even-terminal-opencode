import { test } from "node:test";
import assert from "node:assert/strict";
import { DeltaCoalescer } from "../src/throttle.ts";

function fakeClock() {
  const tasks: Array<{ fn: () => void; at: number }> = [];
  let time = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      tasks.push({ fn, at: time + ms });
      return tasks.length;
    },
    cancel: (t: unknown) => {
      const idx = Number(t) - 1;
      if (tasks[idx]) tasks.splice(idx, 1);
    },
    advance(ms: number) {
      time += ms;
      for (const task of [...tasks].sort((a, b) => a.at - b.at)) {
        if (task.at <= time) {
          tasks.splice(tasks.indexOf(task), 1);
          task.fn();
        }
      }
    },
  };
}

test("first delta of a burst flushes immediately (leading edge)", () => {
  const clock = fakeClock();
  const flushed: Array<[string, string]> = [];
  const c = new DeltaCoalescer((sid, text) => flushed.push([sid, text]), {
    schedule: clock.schedule,
    cancel: clock.cancel,
    flushMs: 200,
  });
  c.push("s1", "Hel");
  assert.deepEqual(flushed, [["s1", "Hel"]]); // instant
  c.push("s1", "lo ");
  c.push("s1", "world");
  assert.equal(flushed.length, 1); // batched inside the window
  clock.advance(200);
  assert.deepEqual(flushed, [
    ["s1", "Hel"],
    ["s1", "lo world"],
  ]);
});

test("after the window closes, the next delta leads again", () => {
  const clock = fakeClock();
  const flushed: Array<[string, string]> = [];
  const c = new DeltaCoalescer((sid, text) => flushed.push([sid, text]), {
    schedule: clock.schedule,
    cancel: clock.cancel,
    flushMs: 100,
  });
  c.push("s", "a");
  clock.advance(200); // window closed, buffer empty
  c.push("s", "b");
  assert.deepEqual(flushed, [
    ["s", "a"],
    ["s", "b"],
  ]);
  assert.ok(flushed.length === 2); // both flushed immediately (leading edge)
});

test("deltas for different sessions flush independently", () => {
  const clock = fakeClock();
  const flushed: Array<[string, string]> = [];
  const c = new DeltaCoalescer((sid, text) => flushed.push([sid, text]), {
    schedule: clock.schedule,
    cancel: clock.cancel,
    flushMs: 100,
  });
  c.push("a", "A1");
  clock.advance(100);
  c.push("b", "B1");
  clock.advance(100);
  assert.deepEqual(flushed, [
    ["a", "A1"],
    ["b", "B1"],
  ]);
});

test("explicit flush emits buffered text and cancels the pending timer", () => {
  const clock = fakeClock();
  const flushed: Array<[string, string]> = [];
  const c = new DeltaCoalescer((sid, text) => flushed.push([sid, text]), {
    schedule: clock.schedule,
    cancel: clock.cancel,
    flushMs: 200,
  });
  c.push("s", "abc"); // leads immediately
  c.push("s", "def"); // buffered
  assert.deepEqual(flushed, [["s", "abc"]]);
  c.flush("s");
  clock.advance(500); // cancelled timer must not double-flush
  assert.deepEqual(flushed, [
    ["s", "abc"],
    ["s", "def"],
  ]);
});

test("buffer flushes early once maxChars is reached", () => {
  const clock = fakeClock();
  const flushed: Array<[string, string]> = [];
  const c = new DeltaCoalescer((sid, text) => flushed.push([sid, text]), {
    schedule: clock.schedule,
    cancel: clock.cancel,
    flushMs: 10_000,
    maxChars: 10,
  });
  c.push("s", "12345"); // leading edge -> immediate
  c.push("s", "6789012345"); // batch hits maxChars -> early flush
  assert.deepEqual(flushed, [["s", "12345"], ["s", "6789012345"]]);
});
