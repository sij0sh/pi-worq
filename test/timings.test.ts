import assert from "node:assert/strict";
import { test } from "node:test";
import { RunTimings } from "../src/timings.ts";

test("Claude-style response and ask overlap preserves observed wait and excludes it from work", () => {
  let now = 0;
  const timings = new RunTimings(0, () => now);
  timings.event({ type: "response-start" });
  now = 10;
  const toolEnd = timings.tool();
  now = 20;
  const answer = timings.waitMain();
  now = 50;
  timings.event({ type: "response", completed: true });
  now = 70;
  answer();
  now = 80;
  toolEnd();
  const t = timings.snapshot();
  assert.equal(t.activeModelMs, 50);
  assert.equal(t.waitMainMs, 50);
  assert.equal(t.toolMs, 70);
  assert.equal(t.workModelMs, 20);
  assert.equal(t.workToolMs, 10);
  assert.equal(t.workMs, 30);
});

test("overlapping read calls retain individual durations and only count shared work once", () => {
  let now = 0;
  const timings = new RunTimings(0, () => now);
  const endFirst = timings.tool();
  now = 10;
  const endSecond = timings.tool();
  now = 20;
  endSecond();
  now = 40;
  endFirst();
  const t = timings.snapshot();
  assert.equal(t.toolCalls, 2);
  assert.equal(t.toolMs, 50);
  assert.equal(t.workToolMs, 40);
  assert.equal(t.workMs, 40);
});
