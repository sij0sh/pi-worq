import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflows } from "../src/runtime/workflows.ts";
import { Telemetry } from "../src/telemetry.ts";
import { KINDS, pass, repo, setup } from "./fake.ts";

async function until(check: () => boolean, deadline = 5000) {
  const end = Date.now() + deadline;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("scout: inline lifecycle, zero repo diff, summary in digest, and ref attachable downstream", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let executePayload = "";
  const { worq, next } = setup(root, state, {
    "agent.scout": async (turn) => {
      await turn.tool("submit", {
        summary: "Greeting lives at app.py:1 (`print('hello')`).",
        report: "## Evidence\n- `app.py:1`: `print('hello')`",
      });
    },
    "agent.execute": async (turn) => {
      executePayload = turn.text;
      await turn.tool("submit", { summary: "Done using scout evidence" });
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  });

  const scout = await worq.spawn("scout", "Locate the greeting print call", { title: "Find greeting" });
  const notice = await next("done", scout.ref);

  assert.equal(scout.state, "done");
  assert.equal(scout.plan, undefined);
  assert.equal(existsSync(join(root, ".agents", "plans")), false, "inline scout never writes .agents/plans");
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all").toString().trim(), "", "git status stays clean");
  assert.match(notice.text, /Greeting lives at app\.py:1/);
  assert.match(notice.text, new RegExp(`Full report: worq_list\\(${scout.ref}\\)`));
  assert.match(worq.list(scout.ref), /Submission:\nGreeting lives at app\.py:1[\s\S]*## Evidence/);

  const exec = await worq.spawn("execute", "Update greeting", { title: "Update greeting", attach: [scout.ref] });
  assert.deepEqual(exec.attachments.map((a) => a.path), [`inline/${scout.ref}.md`]);
  await next("parked", exec.ref);
  assert.match(executePayload, /Greeting lives at app\.py:1/);
  assert.match(executePayload, /## Evidence/);
  await worq.cancel("all");
});

test("scout: zero-ask removes ask_main tool and frontmatter budgets clamp strictly against config limits", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. asks: 0 removes ask_main; limits.agentTurns: 4 clamps below scout's max-turns: 16.
  let seenTools: string[] = [];
  let unfencedTurns = 0;
  const lowConfig = setup(root, state, {
    "agent.scout": async (turn) => {
      seenTools = turn.spec.tools.map((tool) => tool.name);
      const out = await turn.tool("list_files", { path: "." });
      if (/Tool dispatch is closed/.test(out)) return;
      unfencedTurns++;
      turn.steered.push(`keep going ${unfencedTurns}`);
    },
  }, { agentTurns: 4 });
  const a = await lowConfig.worq.spawn("scout", "Loop until capped", { title: "Cap scout" });
  const parked = await lowConfig.next("parked", a.ref);
  assert.ok(!seenTools.includes("ask_main"), "asks: 0 removes ask_main completely");
  assert.equal(unfencedTurns, 4, "frontmatter max-turns: 16 cannot exceed config.limits.agentTurns: 4");
  assert.match(parked.text, /turn limit \(4\)/);
  await lowConfig.worq.cancel("all");

  // 2. Custom inline kind with max-turns: 2 clamps below config.limits.agentTurns: 80.
  const tightKind = { ...KINDS.get("scout")!, name: "tight-scout", limits: { turns: 2, minutes: 5, asks: 0 } };
  const kinds = new Map([...KINDS, ["tight-scout", tightKind]]);
  let tightTurns = 0;
  const highConfig = setup(root, state, {
    "agent.tight-scout": async (turn) => {
      const out = await turn.tool("list_files", { path: "." });
      if (/Tool dispatch is closed/.test(out)) return;
      tightTurns++;
      turn.steered.push(`step ${tightTurns}`);
    },
  }, { agentTurns: 80 }, undefined, kinds);
  const b = await highConfig.worq.spawn("tight-scout", "Loop until frontmatter cap", { title: "Tight cap" });
  const tightParked = await highConfig.next("parked", b.ref);
  assert.equal(tightTurns, 2, "frontmatter max-turns: 2 narrows config.limits.agentTurns: 80");
  assert.match(tightParked.text, /turn limit \(2\)/);
  await highConfig.worq.cancel("all");
});

test("scout: separate capacity pool and semaphore queueing with clean cancel while queued", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const telemetry = new Telemetry();
  let runningScouts = 0;
  let maxConcurrentScouts = 0;
  const releases: (() => void)[] = [];
  let releaseExec!: () => void;

  const { worq, next } = setup(root, state, {
    "agent.execute": async (turn) => {
      await new Promise<void>((resolve) => { releaseExec = resolve; });
      await turn.tool("submit", { summary: "Exec done" });
    },
    "agent.scout": async (turn) => {
      runningScouts++;
      maxConcurrentScouts = Math.max(maxConcurrentScouts, runningScouts);
      try {
        await new Promise<void>((resolve) => { releases.push(resolve); });
        await turn.tool("submit", { summary: `Done ${turn.spec.name}` });
      } finally {
        runningScouts--;
      }
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, { agents: 1, parallel: 2, scouts: 6 }, telemetry);

  const exec = await worq.spawn("execute", "Heavy worker", { title: "Heavy worker" });
  // Second heavy agent hits limits.agents: 1, while 4 scouts use limits.scouts: 6.
  await assert.rejects(worq.spawn("plan", "Second heavy", { title: "Second heavy" }), /limits\.agents 1/);

  const scouts = await Promise.all([
    worq.spawn("scout", "Recon 1", { title: "Recon one" }),
    worq.spawn("scout", "Recon 2", { title: "Recon two" }),
    worq.spawn("scout", "Recon 3", { title: "Recon three" }),
    worq.spawn("scout", "Recon 4", { title: "Recon four" }),
  ]);

  await until(() => releases.length === 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(maxConcurrentScouts, 2, "parallel semaphore caps concurrent scouts at 2");
  const queuedRows = [...telemetry.rows.values()].filter((r) => r.role === "scout" && r.state === "queued");
  assert.equal(queuedRows.length, 2, "2 scouts wait in queued state");

  // Cancel one queued scout cleanly while the first 2 are still running.
  const queuedRef = queuedRows[0].ref;
  await worq.cancel(queuedRef);
  assert.equal(worq.get(queuedRef).state, "cancelled");

  // Release the 2 running scouts so the remaining queued scout runs and finishes.
  releases.shift()!();
  releases.shift()!();
  await until(() => releases.length === 1);
  releases.shift()!();

  for (const s of scouts) {
    if (s.ref !== queuedRef) await next("done", s.ref);
  }
  assert.equal(maxConcurrentScouts, 2);
  releaseExec();
  await next("parked", exec.ref);
  await worq.cancel("all");
});

test("workflow loader: fail-closed validation for output, frontmatter caps and gates.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-wf-scout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writePkg = async (name: string, files: Record<string, string>) => {
    await mkdir(join(dir, "workflows", name), { recursive: true });
    for (const [f, content] of Object.entries(files)) {
      await writeFile(join(dir, "workflows", name, f), content);
    }
  };
  await writePkg("good-inline", {
    "SKILL.md": "---\nname: good-inline\ndescription: Good\naccess: read\noutput: inline\nmax-turns: 10\nmax-minutes: 3\nasks: 0\n---\nBody.\n",
  });
  await writePkg("write-inline", {
    "SKILL.md": "---\nname: write-inline\ndescription: Bad\naccess: write\noutput: inline\n---\nBody.\n",
  });
  await writePkg("bad-output", {
    "SKILL.md": "---\nname: bad-output\ndescription: Bad\naccess: read\noutput: stream\n---\nBody.\n",
  });
  await writePkg("bad-turns", {
    "SKILL.md": "---\nname: bad-turns\ndescription: Bad\naccess: read\nmax-turns: 0\n---\nBody.\n",
  });
  await writePkg("read-gates", {
    "SKILL.md": "---\nname: read-gates\ndescription: Bad\naccess: read\n---\nBody.\n",
    "gates.json": JSON.stringify([{ executable: "node", args: ["-v"] }]),
  });
  await writePkg("good-write-gates", {
    "SKILL.md": "---\nname: good-write-gates\ndescription: Good write\naccess: write\n---\nBody.\n",
    "gates.json": JSON.stringify([{ name: "node-v", executable: "node", args: ["-v"] }]),
  });

  const { kinds, problems } = loadWorkflows(dir);
  assert.deepEqual([...kinds.keys()], ["good-inline", "good-write-gates"]);
  assert.equal(kinds.get("good-inline")!.output, "inline");
  assert.deepEqual(kinds.get("good-inline")!.limits, { turns: 10, minutes: 3, asks: 0 });
  assert.equal(kinds.get("good-write-gates")!.gates?.length, 1);
  assert.ok(!kinds.get("good-write-gates")!.skill.files.includes("gates.json"));
  const msg = (name: string) => problems.find((p) => p.path.endsWith(`/${name}`) || p.path.endsWith(`\\${name}`))?.message ?? "";
  assert.match(msg("write-inline"), /output is only valid when access is read/);
  assert.match(msg("bad-output"), /output must be plan or inline/);
  assert.match(msg("bad-turns"), /max-turns must be between 1 and 400/);
  assert.match(msg("read-gates"), /gates\.json is only valid when access is write/);
});
