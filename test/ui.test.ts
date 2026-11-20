import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunView } from "../src/controller.ts";
import { renderRail, summary } from "../src/ui.ts";

const contract = { request: "r", outcome: "Print OK", boundaries: [], assumptions: [], criteria: [{ id: "result", outcome: "Prints OK" }] };
const base: RunView = { version: 1, id: "00000000-0000-0000-0000-000000000000", owner: 1, started: 0, phase: "Execute", state: "running",
  activity: "Building in the candidate worktree", attempt: 1, request: "r", branch: "worq/x", reports: [], path: [], contract,
  jobs: [{ id: "j1", kind: "read", state: "running", task: "t" }] };
const views: Record<string, RunView> = {
  running: base,
  question: { ...base, phase: "Plan", state: "question", question: "Which text should the CLI print? ".repeat(6) },
  pass: { ...base, phase: "Verify", state: "pass", finished: 151_000, candidate: "1a2b3c4d5e6f" },
  blocked: { ...base, state: "blocked", activity: "Commit or remove local changes", code: "dirty-baseline" },
};

for (const [name, view] of Object.entries(views)) {
  for (const width of [100, 45, 30, 8]) {
    test(`rail ${name} fits width ${width}`, () => {
      const lines = renderRail(view, width, undefined, 3, 42_000);
      assert.ok(lines.length > 0);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} > ${width}`);
    });
  }
}

test("rail shows phases, progress and pause cues", () => {
  const running = renderRail(views.running, 100, undefined, 0, 42_000).join("\n");
  assert.match(running, /◆ worq ─+ round 1\/3 · 0:42/);
  assert.match(running, /✓ Plan ━━ ⠋ Execute ── ○ Verify/);
  assert.match(running, /Building in the candidate worktree · 1 job/);
  const paused = renderRail(views.question, 100, undefined, 0, 42_000).join("\n");
  assert.match(paused, /needs you/);
  assert.match(paused, /\? Which text/);
  assert.match(paused, /type your answer below/);
  assert.match(renderRail(views.running, 30, undefined, 0, 0)[1], /✓⠋○ Execute/);
  const waiting = { ...views.running, pending: [{ id: "g1", kind: "gate" as const, gate: "plan" as const, body: "steps", created: 0 }] };
  assert.match(renderRail(waiting, 100, undefined, 0, 0)[0], /worq ── waiting on Pi/);
});

test("finished runs collapse to one summary line", () => {
  assert.deepEqual(renderRail(views.pass, 100, undefined, 0, 0), [summary(views.pass)]);
  assert.match(summary(views.pass), /^✔ worq PASS · Verify agent accepted · 1a2b3c4d on worq\/x · not merged · 2:31$/);
  assert.match(summary(views.blocked, undefined, 42_000), /^✖ worq BLOCKED · Commit or remove local changes · 0:42$/);
});
