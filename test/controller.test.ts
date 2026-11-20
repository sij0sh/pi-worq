import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { parse } from "../src/contracts.ts";
import { archived, Run, type Assignment } from "../src/controller.ts";
import { cleanEnv, launch, runProcess } from "../src/process.ts";

const app = `print('old result')\n`;
const good = `print(input().upper())\n`;
const taskText = "Make loading a note print its contents in uppercase";
const scope = { outcome: "Show the loaded input uppercased", assumptions: [], boundaries: [], criteria: [{ id: "uppercase", outcome: "Fixture contents are printed in uppercase" }] };
const plan = { mode: "change", contract: scope, summary: "Change formatting", steps: ["Edit app.py"], verificationNote: "Try a mixed-case note." };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "worq-test-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=fixture", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  await writeFile(join(repo, "app.py"), app);
  git("add", "app.py"); git("commit", "-qm", "baseline");
  return { dir, repo, git, stateDir: join(dir, "state"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function observe({ cwd, signal }: Assignment) {
  const { stdout } = await runProcess("/usr/bin/python3", ["app.py"], { cwd, env: cleanEnv, signal, ms: 3000, stdin: "aBC\n" });
  return { verdict: stdout === "ABC\n" ? "pass" : "fail", summary: `Printed ${stdout.trim()}`, notes: "Ran app.py with aBC on stdin." };
}
function run(f: Fixture, execute: (assignment: Assignment) => Promise<void>, options: {
  plan?: (assignment: Assignment) => object | Promise<object>; verify?: (assignment: Assignment) => object | Promise<object>;
  request?: string; interactive?: boolean; manager?: boolean; lenses?: string[]; useLenses?: boolean;
} = {}) {
  const calls: Assignment[] = [];
  const lensCalls: { lens: string; task: object }[] = [];
  const instance = new Run({ cwd: f.repo, stateDir: f.stateDir, request: options.request ?? taskText, interactive: options.interactive ?? false, manager: options.manager, lenses: options.useLenses,
    roles: {
      lenses: options.lenses ?? [],
      async lens({ lens, task }) { lensCalls.push({ lens, task }); return lens === "defeater" ? "Check empty notes" : "No consequential findings"; },
      async ask(assignment, schema) {
        calls.push(assignment);
        const { role, bus, identify } = assignment;
        const agent = bus!.register(role, role === "verify");
        identify?.(agent.id);
        try {
          if (role === "execute") { await execute(assignment); return parse(schema, { summary: "Development suite green" }, role); }
          if (role === "plan") return parse(schema, options.plan ? await options.plan(assignment) : plan, role);
          return parse(schema, await (options.verify ?? observe)(assignment), role);
        } finally { agent.close("done"); }
      },
    },
  });
  return { instance, calls, lensCalls };
}
const edit = ({ cwd }: Assignment) => writeFile(join(cwd, "app.py"), good);
async function onlyOnce(predicate: () => boolean) {
  const end = performance.now() + 4000;
  while (!predicate() && performance.now() < end) await sleep(10);
  assert.ok(predicate(), "state transition not observed");
}

test("agent observes the real pinned candidate; reports have identity and the original tree is untouched", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const { instance, calls } = run(f, edit);
  await instance.done;
  const view = instance.view;
  assert.equal(view.state, "pass", view.activity);
  assert.equal(view.contract?.request, taskText);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(await readFile(join(f.repo, "app.py"), "utf8"), app);
  assert.equal(f.git("rev-parse", view.branch), view.candidate);
  assert.notEqual(f.git("rev-parse", "HEAD"), view.candidate);
  const [p, e, v] = view.reports;
  assert.deepEqual([p.phase, e.phase, v.phase], ["Plan", "Execute", "Verify"]);
  assert.equal(v.commit, view.candidate);
  assert.equal(v.run, view.id);
  assert.match(v.agent!, /^v\d+$/);
  assert.equal(v.summary, "Printed ABC");
  assert.equal(v.verdict, "pass");
  const verify = calls.find((x) => x.role === "verify")!;
  assert.deepEqual(verify.task, { request: taskText, contract: view.contract, commit: view.candidate, verificationNote: plan.verificationNote });
  assert.notEqual(verify.cwd, calls.find((x) => x.role === "execute")?.cwd);
  await assert.rejects(stat(verify.cwd), { code: "ENOENT" });
  assert.deepEqual((await archived(f.stateDir, view.id, f.repo)).reports, JSON.parse(JSON.stringify(view.reports)));
});

test("report-only works on a dirty repo, but a change cannot start from it", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(join(f.repo, "local.txt"), "local notes");
  const audit = run(f, async () => assert.fail("Report reached Execute"), { plan: () => ({ mode: "report", summary: "Audit finding" }) });
  await audit.instance.done;
  assert.equal(audit.instance.view.state, "report-ready");
  assert.deepEqual(audit.calls.map((c) => c.role), ["plan"]);
  assert.equal(f.git("branch", "--list", "worq/*"), "");
  const change = run(f, async () => assert.fail("Dirty baseline reached Execute"));
  await change.instance.done;
  assert.equal(change.instance.view.code, "dirty-baseline");
  assert.equal((await archived(f.stateDir, change.instance.view.id, f.repo)).reports.length, 1);
});

test("a prior pass and green Execute cannot pass wrong behavior; repairs use fresh checkouts", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const first = run(f, edit);
  await first.instance.done;
  assert.equal(first.instance.view.state, "pass");
  const { instance, calls } = run(f, async () => {});
  await instance.done;
  assert.equal(instance.view.state, "fail", instance.view.activity);
  assert.equal(instance.view.attempt, 3);
  assert.deepEqual(instance.view.reports.filter((r) => r.verdict).map((r) => r.verdict), ["fail", "fail", "fail"]);
  assert.deepEqual(calls.map((x) => x.role), ["plan", "execute", "verify", "execute", "verify", "execute", "verify"]);
  assert.equal(new Set(calls.filter((x) => x.role === "verify").map((a) => a.cwd)).size, 3);
  assert.deepEqual((calls[3].task as { feedback: unknown }).feedback, { summary: "Printed old result", notes: "Ran app.py with aBC on stdin." });
});

test("repair records its own verdict and commit; an unavailable check ends inconclusive", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let attempts = 0;
  const repaired = run(f, async (assignment) => { if (++attempts === 2) await edit(assignment); });
  await repaired.instance.done;
  const verdicts = repaired.instance.view.reports.filter((r) => r.verdict);
  assert.deepEqual(verdicts.map((v) => v.verdict), ["fail", "pass"]);
  assert.notEqual(verdicts[0].commit, verdicts[1].commit);
  const blocked = run(f, edit, { verify: () => ({ verdict: "inconclusive", summary: "Browser not available" }) });
  await blocked.instance.done;
  assert.equal(blocked.instance.view.state, "inconclusive");
  assert.equal(blocked.instance.view.attempt, 1);
  assert.equal(blocked.instance.view.reports.at(-1)?.summary, "Browser not available");
});

test("no verdict or a mutated verification checkout cannot advance to PASS", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const noVerdict = run(f, edit, { verify: () => ({ summary: "forgot" }) });
  await noVerdict.instance.done;
  assert.equal(noVerdict.instance.view.code, "invalid-payload");
  const mutated = run(f, edit, { verify: async ({ cwd }) => {
    await writeFile(join(cwd, "app.py"), app);
    return { verdict: "pass", summary: "Claimed acceptance" };
  } });
  await mutated.instance.done;
  assert.equal(mutated.instance.view.code, "candidate-mutated");
  assert.ok(mutated.instance.view.reports.every((entry) => !entry.verdict));
  assert.equal(f.git("status", "--porcelain"), "");
});

test("consequential ambiguity pauses without a worktree; cancelled late completion cannot advance", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let resolved = false;
  const r = run(f, async (a) => { await sleep(200); await edit(a); resolved = true; }, {
    plan: async ({ bus, signal }) => {
      const agent = bus!.register("plan", false);
      assert.equal(await bus!.ask(agent.id, "Which result should the note show?", signal), "User: Uppercase");
      return plan;
    }, interactive: true,
  });
  await onlyOnce(() => r.instance.view.state === "question");
  assert.equal(f.git("branch", "--list", "worq/*"), "");
  assert.equal(r.instance.answer("Uppercase"), true);
  await onlyOnce(() => r.calls.some((c) => c.role === "execute"));
  const done = r.instance.stop();
  assert.equal(r.instance.view.state, "stopping");
  assert.equal(resolved, false);
  await done;
  assert.equal(r.instance.view.state, "cancelled");
  assert.equal(resolved, true);
  assert.equal(r.instance.view.candidate, undefined);
  assert.ok(!r.calls.some((c) => c.role === "verify"));
});

test("managed process cancellation waits for terminate handler and joins", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const signal = new AbortController();
  const marker = join(f.dir, "joined-marker");
  const source = `import signal,time,pathlib\ndef stop(*_):\n time.sleep(.07)\n pathlib.Path(${JSON.stringify(marker)}).write_text('joined')\n raise SystemExit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('ready',flush=True)\nwhile True: time.sleep(1)\n`;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const process = launch("/usr/bin/python3", ["-I", "-c", source], { cwd: f.repo, env: cleanEnv, signal: signal.signal, ms: 1500, stdout: () => ready() });
  await started;
  const reason = new Error("test stop");
  signal.abort(reason);
  await assert.rejects(process.done, (error) => error === reason);
  assert.equal(await readFile(marker, "utf8"), "joined");
});

test("plan lenses and candidate reviews still revise handoffs; Verify gets only the outcome and prose guidance", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let executions = 0;
  const r = run(f, async (a) => { if (++executions === 2) await edit(a); }, { manager: true, interactive: true, lenses: ["pair", "defeater"] });
  const decide = async (gate: string, decision: "approve" | "revise", text?: string) => {
    await onlyOnce(() => r.instance.bus?.pendingView().some((p) => p.gate === gate) ?? false);
    const pending = r.instance.bus!.pendingView().find((p) => p.gate === gate)!;
    r.instance.bus!.review(pending.id, decision, text);
    return pending;
  };
  const planGate = await decide("plan", "revise", "Also cover empty notes");
  assert.match(planGate.body, /Edit app.py/);
  assert.match(planGate.body, /Lens findings[\s\S]*\[defeater\] Check empty notes/);
  assert.equal(r.lensCalls.length, 2);
  const candidate = await decide("candidate", "revise", "Uppercase is still missing");
  assert.match(candidate.body, /Development suite green/);
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  const plans = r.calls.filter((c) => c.role === "plan");
  assert.equal(plans.length, 2);
  assert.equal((plans[1].task as { review?: string }).review, "Also cover empty notes");
  assert.equal((r.calls.filter((c) => c.role === "execute")[1].task as { review?: string }).review, "Uppercase is still missing");
  assert.deepEqual(Object.keys(r.calls.find((x) => x.role === "verify")!.task).sort(), ["commit", "contract", "request", "verificationNote"]);
  assert.ok(r.instance.view.path.some((step) => step === "1 · plan review: revise"));
  assert.deepEqual(r.instance.view.jobs.map((j) => j.state), ["done", "done"]);

  const off = run(f, edit, { lenses: ["pair"] });
  await off.instance.done;
  assert.equal(off.lensCalls.length, 0);
  assert.ok(off.instance.view.path.includes("1 · lenses skipped: no Pi plan review"));
  const disabled = run(f, edit, { manager: true, lenses: ["pair"], useLenses: false });
  for (const gate of ["plan", "candidate"]) {
    await onlyOnce(() => disabled.instance.bus?.pendingView().some((p) => p.gate === gate) ?? false);
    disabled.instance.bus!.review(disabled.instance.bus!.pendingView().find((p) => p.gate === gate)!.id, "approve");
  }
  await disabled.instance.done;
  assert.equal(disabled.lensCalls.length, 0);
});
