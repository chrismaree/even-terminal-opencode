import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageHub } from "../src/hub.ts";

test("ring buffer keeps the active turn when overflowing past 500", () => {
  const hub = new MessageHub();
  // start a turn: user_prompt + 600 deltas
  hub.emit("s", { type: "user_prompt", text: "do the thing" });
  for (let i = 0; i < 600; i++) {
    hub.emit("s", { type: "text_delta", text: "x" });
  }
  const buffered = hub.getMessages("s", 0);
  assert.ok(
    buffered.some((m) => m.type === "user_prompt"),
    "active turn's user prompt must survive the trim",
  );
  // non-turn messages were trimmed: the buffer is capped at ~MAX+current turn
  assert.ok(buffered.length < 700, `expected bounded buffer, got ${buffered.length}`);
});

test("after idle, trimming resumes normally", () => {
  const hub = new MessageHub();
  hub.emit("s", { type: "user_prompt", text: "turn one" });
  hub.emit("s", { type: "status", state: "idle" });
  hub.emit("s", { type: "user_prompt", text: "turn two" });
  for (let i = 0; i < 600; i++) {
    hub.emit("s", { type: "text_delta", text: "y" });
  }
  const buffered = hub.getMessages("s", 0);
  // after idle, turn one is fair game for the trim; the newest turn survives
  const first = buffered[0]!;
  assert.equal(first.type, "user_prompt");
  assert.equal((first as { text: string }).text, "turn two");
});
