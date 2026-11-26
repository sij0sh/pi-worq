import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflows, type Kind } from "../src/runtime/workflows.ts";
import type { Capabilities, Spec } from "../src/sdk/contract.ts";
import { baselineProject, reserveName, validateBundleFiles, validateBundlePath } from "../src/workspace.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, FULL_CAPS, KINDS, pass, repo, setup, type Script } from "./fake.ts";

const FORK_CAPS: Capabilities = { ...FULL_CAPS, contextFork: true };

async function writePkg(dir: string, name: string, files: Record<string, string>) {
  await mkdir(join(dir, "workflows", name), { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    await writeFile(join(dir, "workflows", name, f), content);
  }
}

function makeKinds(custom: Map<string, Kind>) {
  return new Map([...KINDS, ...custom]);
}

test("workflow loader: conversational and output: bundle validation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-wf-conv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writePkg(dir, "good-conv", {
    "SKILL.md": "---\nname: good-conv\ndescription: Conversational bundle\naccess: read\noutput: bundle\nconversational: true\n---\nDiscuss and emit files.\n",
  });
  await writePkg(dir, "good-reviewed-bundle", {
    "SKILL.md": "---\nname: good-reviewed-bundle\ndescription: Reviewed bundle\naccess: read\noutput: bundle\n---\nEmit dossier.\n",
    "REVIEW.md": "Review every file in the brief.",
  });
  await writePkg(dir, "write-conv", {
    "SKILL.md": "---\nname: write-conv\ndescription: Bad write conv\naccess: write\nconversational: true\n---\nBody.\n",
  });
  await writePkg(dir, "conv-review", {
    "SKILL.md": "---\nname: conv-review\ndescription: Bad conv with review\naccess: read\nconversational: true\n---\nBody.\n",
    "REVIEW.md": "Should be rejected.",
  });
  await writePkg(dir, "bad-conv-val", {
    "SKILL.md": "---\nname: bad-conv-val\ndescription: Bad bool\naccess: read\nconversational: yes\n---\nBody.\n",
  });
  await writePkg(dir, "write-bundle", {
    "SKILL.md": "---\nname: write-bundle\ndescription: Bad write bundle\naccess: write\noutput: bundle\n---\nBody.\n",
  });

  const { kinds, problems } = loadWorkflows(dir);
  assert.deepEqual([...kinds.keys()], ["good-conv", "good-reviewed-bundle"]);
  assert.equal(kinds.get("good-conv")!.conversational, true);
  assert.equal(kinds.get("good-conv")!.output, "bundle");
  assert.equal(kinds.get("good-reviewed-bundle")!.conversational, false);
  assert.equal(kinds.get("good-reviewed-bundle")!.output, "bundle");
  assert.equal(kinds.get("good-reviewed-bundle")!.review, "Review every file in the brief.");

  const msg = (name: string) => problems.find((p) => p.path.endsWith(`/${name}`) || p.path.endsWith(`\\${name}`))?.message ?? "";
  assert.match(msg("write-conv"), /conversational is only valid when access is read/);
  assert.match(msg("conv-review"), /REVIEW\.md is not supported when conversational is true/);
  assert.match(msg("bad-conv-val"), /conversational must be true or false/);
  assert.match(msg("write-bundle"), /output is only valid when access is read/);
});

test("conversational multi-round loop: parks after each submit, releases slot, never sets final, and closes cleanly", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = await mkdtemp(join(tmpdir(), "worq-prof-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writePkg(profile, "chat", {
    "SKILL.md": "---\nname: chat\ndescription: Conversational partner\naccess: read\noutput: bundle\nconversational: true\n---\nIterate.\n",
  });
  const kinds = makeKinds(loadWorkflows(profile).kinds);

  let round = 0;
  const { worq, next } = setup(root, state, {
    "agent.chat": async (turn) => {
      round++;
      if (round === 1) {
        await turn.tool("submit", {
          summary: "Round 1 framing complete.",
          files: [
            { path: "00-index.md", content: "# Index v1\n" },
            { path: "01-grounding.md", content: "# Grounding\n" },
          ],
        });
      } else {
        assert.match(turn.text, /^Main: Deep dive on option B/);
        await turn.tool("submit", {
          summary: "Round 2 added option B deep dive.",
          files: [
            { path: "00-index.md", content: "# Index v2\n" },
            { path: "02-option-b.md", content: "# Option B\n" },
          ],
        });
      }
    },
    "agent.plan": async (turn) => {
      await turn.tool("submit", { summary: "Plan while chat parked" });
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, { agents: 1, idleMinutes: 45 }, undefined, kinds);
  t.after(() => worq.shutdown());

  const agent = await worq.spawn("chat", "Explore caching options", { title: "Cache options" });
  const park1 = await next("parked", agent.ref, 1);

  assert.equal(agent.state, "parked");
  assert.equal(agent.final, false);
  assert.equal(agent.rounds, 1);
  assert.equal(agent.active, false, "parked conversational agent releases its active slot");
  assert.match(park1.text, /parked · round 1/);
  assert.match(park1.text, /Brief: \.agents\/briefs\/cache-options\/ \(2 files\)/);
  assert.match(park1.text, /Reply with worq_send\(cache-options, \.\.\.\) to continue, or worq_cancel\(cache-options\) to close \(auto-closes after 45m idle\)/);
  assert.doesNotMatch(park1.text, /review inconclusive|final revision/i);

  const detail1 = worq.list(agent.ref);
  assert.match(detail1, /Phase: conversational round 1; awaiting worq_send or worq_cancel/);
  assert.match(detail1, /Brief: \.agents\/briefs\/cache-options\/ \(2 files\)/);
  assert.match(detail1, /Submission:\nRound 1 framing complete\./);
  assert.doesNotMatch(detail1, /review inconclusive|final revision/i);

  // Active slot was released: another agent can spawn and run under limits.agents = 1.
  const other = await worq.spawn("plan", "Quick plan", { title: "Quick plan" });
  await next("parked", other.ref);
  await worq.cancel(other.ref);

  // Round 2 follow-up via worq_send.
  const sent = worq.send(agent.ref, "Deep dive on option B");
  assert.equal(sent, `Sent follow-up to ${agent.ref} (round 2); it will park again after submitting`);
  const park2 = await next("parked", agent.ref, 2);

  assert.equal(agent.state, "parked");
  assert.equal(agent.final, false);
  assert.equal(agent.rounds, 2);
  assert.match(park2.text, /parked · round 2/);
  assert.match(park2.text, /Brief: \.agents\/briefs\/cache-options\/ \(3 files\)/);
  assert.deepEqual(agent.bundle, {
    dir: ".agents/briefs/cache-options",
    files: ["00-index.md", "01-grounding.md", "02-option-b.md"],
    updated: ["00-index.md", "02-option-b.md"],
  });
  assert.equal(await readFile(join(root, ".agents/briefs/cache-options/00-index.md"), "utf8"), "# Index v2\n");
  assert.equal(await readFile(join(root, ".agents/briefs/cache-options/01-grounding.md"), "utf8"), "# Grounding\n");
  assert.equal(await readFile(join(root, ".agents/briefs/cache-options/02-option-b.md"), "utf8"), "# Option B\n");
  assert.equal(agent.view().rounds, 2);
  assert.deepEqual(agent.view().bundle, agent.bundle);

  await worq.cancel(agent.ref);
  assert.equal(agent.state, "closed");
});

test("conversational budget exhaustion: round 1 omits 'or reviewed', round 2+ preserves earlier rounds wording", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = await mkdtemp(join(tmpdir(), "worq-prof-exh-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writePkg(profile, "chat-bundle", {
    "SKILL.md": "---\nname: chat-bundle\ndescription: Chat bundle\naccess: read\noutput: bundle\nconversational: true\nmax-turns: 1\n---\nIterate.\n",
  });
  await writePkg(profile, "chat-inline", {
    "SKILL.md": "---\nname: chat-inline\ndescription: Chat inline\naccess: read\noutput: inline\nconversational: true\nmax-turns: 1\n---\nIterate.\n",
  });
  const kinds = makeKinds(loadWorkflows(profile).kinds);

  // Round 1 exhaustion on conversational bundle (no REVIEW.md).
  const first = setup(root, state, {
    "agent.chat-bundle": async (turn) => {
      turn.steered.push("keep thinking");
    },
  }, { agentTurns: 1 }, undefined, kinds);
  t.after(() => first.worq.shutdown());
  const a1 = await first.worq.spawn("chat-bundle", "Stuck on round 1", { title: "Stuck round one" });
  const exh1 = await first.next("parked", a1.ref, 1);
  assert.match(exh1.text, /Nothing was submitted\./);
  assert.doesNotMatch(exh1.text, /or reviewed/);

  // Round 2 exhaustion on conversational bundle (round 1 succeeded).
  let r2 = 0;
  const second = setup(root, state, {
    "agent.chat-bundle": async (turn) => {
      r2++;
      if (r2 === 1) {
        await turn.tool("submit", { summary: "Round 1 ok", files: [{ path: "00-index.md", content: "# OK\n" }] });
      } else {
        turn.steered.push("loop past turn limit");
      }
    },
  }, { agentTurns: 1 }, undefined, kinds);
  t.after(() => second.worq.shutdown());
  const a2 = await second.worq.spawn("chat-bundle", "Two rounds", { title: "Round two budget" });
  await second.next("parked", a2.ref, 1);
  second.worq.send(a2.ref, "Now exhaust budget");
  const exh2 = await second.next("parked", a2.ref, 2);
  assert.match(exh2.text, /Round 2 did not submit; earlier rounds are on disk at Brief: \.agents\/briefs\/round-two-budget\/ \(1 file\)\./);
  assert.doesNotMatch(exh2.text, /Nothing was submitted/);

  // Round 2 exhaustion on conversational inline.
  let ri = 0;
  const third = setup(root, state, {
    "agent.chat-inline": async (turn) => {
      ri++;
      if (ri === 1) await turn.tool("submit", { summary: "Inline round 1" });
      else turn.steered.push("loop");
    },
  }, { agentTurns: 1 }, undefined, kinds);
  t.after(() => third.worq.shutdown());
  const a3 = await third.worq.spawn("chat-inline", "Inline two rounds", { title: "Inline budget" });
  await third.next("parked", a3.ref, 1);
  third.worq.send(a3.ref, "Exhaust inline");
  const exh3 = await third.next("parked", a3.ref, 2);
  assert.match(exh3.text, /Round 2 did not submit; earlier inline submission is retained\./);
});

test("bundle output: dirty repo writes, path/cap rejection with self-correction, reserveName, baselineProject, and attachments", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Remove .agents/ from .gitignore so untracked .agents/briefs/ actually appears in git status.
  await writeFile(join(root, ".gitignore"), "");
  git("add", ".gitignore");
  git("commit", "-qm", "unignore .agents");

  const profile = await mkdtemp(join(tmpdir(), "worq-prof-bundle-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writePkg(profile, "brief", {
    "SKILL.md": "---\nname: brief\ndescription: One-shot bundle\naccess: read\noutput: bundle\n---\nWrite brief.\n",
  });
  const kinds = makeKinds(loadWorkflows(profile).kinds);

  // Direct validator checks for path edge cases.
  for (const bad of ["../escape.md", "/abs.md", ".git/config", ".hidden.md", "sub/.env", "a\\b.md", "CON.md", "nul", "a/b/c/d.md", "bad space.md"]) {
    assert.throws(() => validateBundlePath(bad), /bundle/i, `should reject ${bad}`);
  }
  assert.throws(() => validateBundleFiles([]), /at least one file/);
  assert.throws(() => validateBundleFiles([{ path: "A.md", content: "1" }, { path: "a.md", content: "2" }]), /Duplicate/);
  assert.throws(() => validateBundleFiles(Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.md`, content: "x".repeat(60_000) }))), /exceed 262144 bytes/);

  // Dirty repo: modify tracked app.py without committing.
  await writeFile(join(root, "app.py"), "print('dirty')\n");

  const errors: string[] = [];
  const { worq, next } = setup(root, state, {
    "agent.brief": async (turn) => {
      // Bad submissions are rejected inside submit without crashing the agent.
      errors.push(await turn.tool("submit", { summary: "bad", files: [] }));
      errors.push(await turn.tool("submit", { summary: "bad", files: [{ path: "../escape.md", content: "no" }] }));
      errors.push(await turn.tool("submit", { summary: "bad", files: [{ path: "A.md", content: "1" }, { path: "a.md", content: "2" }] }));
      errors.push(await turn.tool("submit", { summary: "bad", files: [{ path: ".hidden.md", content: "no" }] }));
      // Self-correct and submit valid bundle.
      await turn.tool("submit", {
        summary: "Clean brief written on dirty repo.",
        files: [
          { path: "00-index.md", content: "# Overview\n" },
          { path: "notes/01-detail.md", content: "# Detail\n" },
        ],
      });
    },
  }, {}, undefined, kinds);
  t.after(() => worq.shutdown());

  const brief = await worq.spawn("brief", "Produce brief", { title: "Dirty brief" });
  await next("done", brief.ref);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((e) => e.startsWith("Error:")), `expected tool errors, got ${JSON.stringify(errors)}`);
  assert.equal(brief.work, undefined, "no worktree for read bundle");
  assert.equal(await readFile(join(root, ".agents/briefs/dirty-brief/00-index.md"), "utf8"), "# Overview\n");
  assert.equal(await readFile(join(root, ".agents/briefs/dirty-brief/notes/01-detail.md"), "utf8"), "# Detail\n");

  // reserveName avoids colliding with existing .agents/briefs/<ref>.
  await mkdir(join(root, ".agents", "briefs", "taken-brief"), { recursive: true });
  const reserved = await reserveName(root, state, "taken-brief");
  assert.equal(reserved.ref, "taken-brief-2");

  // Revert app.py so only untracked .agents/briefs/ remains: baselineProject must pass!
  git("checkout", "--", "app.py");
  const project = await baselineProject(root, AbortSignal.timeout(5000));
  assert.equal(project.root, root);

  // Live bundle ref attachment + explicit .agents/briefs/<ref>/<file> attachment.
  let attachedToPlan: { path: string; text: string }[] = [];
  const planHarness = setup(root, state, {
    "agent.plan": async (turn) => {
      attachedToPlan = JSON.parse(turn.text).attachments ?? [];
      await turn.tool("submit", { summary: "Used brief" });
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, {}, undefined, kinds);
  t.after(() => planHarness.worq.shutdown());

  // 1. Live bundle ref via original worq instance.
  const execFromLive = await worq.spawn("brief", "Consume live", { title: "Consume live", attach: [brief.ref] });
  assert.deepEqual(execFromLive.attachments.map((a) => a.path), [
    ".agents/briefs/dirty-brief/00-index.md",
    ".agents/briefs/dirty-brief/notes/01-detail.md",
  ]);
  await next("done", execFromLive.ref);

  // 2. Non-live brief ref fallback (fresh Worq instance without live agent).
  const p1 = await planHarness.worq.spawn("plan", "Consume disk brief", { title: "Disk brief", attach: ["dirty-brief"] });
  await planHarness.next("parked", p1.ref);
  assert.deepEqual(attachedToPlan.map((a) => a.path), [
    ".agents/briefs/dirty-brief/00-index.md",
    ".agents/briefs/dirty-brief/notes/01-detail.md",
  ]);

  // 3. Explicit .agents/briefs/<ref>/<file> path.
  const p2 = await planHarness.worq.spawn("plan", "Consume single file", { title: "Single brief", attach: [".agents/briefs/dirty-brief/notes/01-detail.md"] });
  await planHarness.next("parked", p2.ref);
  assert.deepEqual(attachedToPlan, [{ path: ".agents/briefs/dirty-brief/notes/01-detail.md", text: "# Detail\n" }]);

  // 4. Reject >256 KiB aggregate attach size across resolved attachments.
  await mkdir(join(root, ".agents", "briefs", "big-brief"), { recursive: true });
  await writeFile(join(root, ".agents", "briefs", "big-brief", "a.md"), "a".repeat(150_000));
  await writeFile(join(root, ".agents", "briefs", "big-brief", "b.md"), "b".repeat(150_000));
  await assert.rejects(
    planHarness.worq.spawn("plan", "Too big", { title: "Too big", attach: ["big-brief"] }),
    /Attachments exceed 262144 bytes total/,
  );
});

test("non-conversational bundle with REVIEW.md hands all file paths to reviewer and hashes cumulative on-disk files", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = await mkdtemp(join(tmpdir(), "worq-prof-revbundle-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writePkg(profile, "dossier", {
    "SKILL.md": "---\nname: dossier\ndescription: Reviewed dossier\naccess: read\noutput: bundle\n---\nWrite dossier.\n",
    "REVIEW.md": "Check all files in the dossier.",
  });
  const kinds = makeKinds(loadWorkflows(profile).kinds);

  let reviewPayload: { submission: string } | undefined;
  const { worq, next } = setup(root, state, {
    "agent.dossier": async (turn) => {
      await turn.tool("submit", {
        summary: "Dossier ready.",
        report: "Key takeaway.",
        files: [
          { path: "01-second.md", content: "Second file.\n" },
          { path: "00-first.md", content: "First file.\n" },
        ],
      });
    },
    review: async (turn) => {
      reviewPayload = JSON.parse(turn.text);
      await turn.tool("submit", pass);
    },
  }, {}, undefined, kinds);
  t.after(() => worq.shutdown());

  const agent = await worq.spawn("dossier", "Audit system", { title: "System dossier" });
  const parked = await next("parked", agent.ref);

  assert.ok(reviewPayload);
  assert.match(reviewPayload.submission, /Dossier ready\./);
  assert.match(reviewPayload.submission, /Key takeaway\./);
  assert.match(reviewPayload.submission, /- \.agents\/briefs\/system-dossier\/00-first\.md/);
  assert.match(reviewPayload.submission, /- \.agents\/briefs\/system-dossier\/01-second\.md/);

  const expectedDigest = createHash("sha256")
    .update("Dossier ready.", "utf8").update("\0")
    .update("Key takeaway.", "utf8").update("\0")
    .update(".agents/briefs/system-dossier/00-first.md\0", "utf8").update("First file.\n", "utf8").update("\0")
    .update(".agents/briefs/system-dossier/01-second.md\0", "utf8").update("Second file.\n", "utf8").update("\0")
    .digest("hex");
  assert.equal(agent.reviewedDigest, expectedDigest);
  assert.match(parked.text, /parked · review passed/);
  assert.match(parked.text, /Brief: \.agents\/briefs\/system-dossier\/ \(2 files\)/);
});

test("fork: true PQ succeeds under output: bundle with byte-identical tool prefix and no files required", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = await mkdtemp(join(tmpdir(), "worq-prof-forkbundle-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writePkg(profile, "chat-pq", {
    "SKILL.md": "---\nname: chat-pq\ndescription: Conversational bundle with PQ\naccess: read\noutput: bundle\nconversational: true\n---\nUse PQs then emit bundle.\n",
    "PQ.md": "Investigate and answer concisely.",
  });
  const kinds = makeKinds(loadWorkflows(profile).kinds);

  const seen: Spec[] = [];
  let parentSpec: Spec | undefined;
  const scripts: Record<string, Script> = {
    "agent.chat-pq": async (turn) => {
      parentSpec = turn.spec;
      if (turn.text.includes('"task"')) {
        await turn.tool("delegate", { name: "check", question: "What is in app.py?", why: "grounding", fork: true });
        return;
      }
      assert.match(turn.text, /Answer \(observed\): prints hello/);
      await turn.tool("submit", {
        summary: "Grounded via forked PQ.",
        files: [{ path: "00-index.md", content: "# Grounded\n" }],
      });
    },
    "subagent.check": async (turn) => {
      // Forked PQ calls submit WITHOUT files — passes schema and maps via forkedAnswer.
      await turn.tool("submit", { summary: "Basis: observed. prints hello" });
    },
  };
  const worq = new Worq({
    driver: fakeDriver(scripts, seen, FORK_CAPS, { snapshot: (spec) => [{ role: "user", content: `hist:${spec.name}` }] }),
    kinds,
    config: config(),
    state,
    cwd: root,
    notify() {},
  });
  t.after(() => worq.shutdown());

  const agent = await worq.spawn("chat-pq", "Ground app.py", { title: "Fork bundle" });
  const deadline = Date.now() + 10_000;
  while (agent.state !== "parked" && !agent.ended && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(agent.state, "parked");
  assert.equal(agent.rounds, 1);
  const child = seen.find((s) => s.name === "subagent.check")!;
  assert.equal(child.system, parentSpec!.system);
  assert.deepEqual(
    child.tools.map((x) => [x.name, x.description, JSON.stringify(x.parameters)]),
    parentSpec!.tools.map((x) => [x.name, x.description, JSON.stringify(x.parameters)]),
  );
  assert.equal(agent.delegations[0].forked, true);
  assert.equal(agent.delegations[0].answer?.basis, "observed");
});

test("group barrier digest handles conversational parked bundle agents without 'review inconclusive'", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = await mkdtemp(join(tmpdir(), "worq-prof-grp-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writePkg(profile, "chat", {
    "SKILL.md": "---\nname: chat\ndescription: Chat\naccess: read\noutput: bundle\nconversational: true\n---\nGo.\n",
  });
  const kinds = makeKinds(loadWorkflows(profile).kinds);

  const { worq, next } = setup(root, state, {
    "agent.chat": async (turn) => {
      await turn.tool("submit", {
        summary: "Explored options.",
        files: [{ path: "00-index.md", content: "# Options\n" }],
      });
    },
  }, {}, undefined, kinds);
  t.after(() => worq.shutdown());

  await worq.spawn("chat", "Explore", { title: "Group chat", group: "explore", notify: "barrier", expect: 1 });
  const barrier = await next("barrier");
  assert.match(barrier.text, /parked · round 1 — Explored options\./);
  assert.match(barrier.text, /\[\.agents\/briefs\/group-chat\/\]/);
  assert.doesNotMatch(barrier.text, /review inconclusive/);
});
