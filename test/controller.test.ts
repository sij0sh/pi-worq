import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { parse, type Contract, type Profile } from "../src/contracts.ts";
import { archived, Run, type Assignment } from "../src/controller.ts";
import { cleanEnv, launch, runProcess } from "../src/process.ts";
import { digest } from "../src/workspace.ts";

const app = `import sys\nprint('old result')\n`;
const good = `import sys\nprint(open(sys.argv[1]).read().strip().upper())\n`;
const taskText = "Make loading a note print its contents in uppercase";
const scope = { outcome: "Show the loaded input uppercased", assumptions: [] as string[], boundaries: [] as string[], criteria: [{ id: "uppercase", outcome: "Fixture contents are printed in uppercase", checks: ["show"] }] };
const contract: Contract = { request: taskText, ...scope };

async function fixture(surface: Profile["surface"] = "cli") {
  const dir = await mkdtemp(join(tmpdir(), "worq-test-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=fixture", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  await writeFile(join(repo, "app.py"), app);
  git("add", "app.py"); git("commit", "-qm", "baseline");
  const profile: Profile = { version: 1, repository: repo, trustLocalCode: true, surface, entry: "app.py", interpreter: "/usr/bin/python3",
    devChecks: [{ id: "green", executable: "/usr/bin/true", args: [] }],
    checks: [{ id: "show", outcome: "Note displayed uppercase", scenarios: [{ id: "sample", name: "Open note", args: ["case.txt"],
      fixtures: [{ path: "case.txt", content: "hello private fixture" }],
      expect: surface === "cli" ? [{ channel: "stdout", op: "equals", value: "HELLO PRIVATE FIXTURE\n" }, { channel: "exit", op: "equals", value: 0 }]
        : [{ channel: "screen", op: "contains", value: "HELLO PRIVATE FIXTURE" }],
      ...(surface === "tui" ? { steps: [{ type: "wait", ms: 100 }, { type: "observe" }, { type: "resize", cols: 54, rows: 12 }, { type: "type", text: "go" }, { type: "press", key: "enter" }, { type: "wait", ms: 100 }, { type: "observe" }] } : {}),
    }] }],
  };
  const profilePath = join(dir, "profile.json");
  const config = () => writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await config();
  const stateDir = join(dir, "state");
  return { dir, repo, git, profile, config, profilePath, stateDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const plan = { contract: scope, summary: "Change formatting", steps: ["Edit app.py"] };
type PlanTask = { feedback?: string; revision?: string; review?: string; lensFindings?: string };
const intent = (task: PlanTask) => (task.feedback ?? "").startsWith("intent");
const journey = { cases: [{ check: "show", scenario: "sample" }] };
function run(f: Fixture, execute: (assignment: Assignment) => Promise<void>, options: {
  plan?: (task: PlanTask, assignment: Assignment) => object | Promise<object>; route?: (assignment: Assignment) => object; interactive?: boolean; profilePath?: string; profilesDir?: string; pick?: () => object; manager?: boolean; lenses?: string[]; useLenses?: boolean;
} = {}) {
  const calls: Assignment[] = [];
  const lensCalls: { lens: string; task: object }[] = [];
  const instance = new Run({ cwd: f.repo, profilePath: options.profilePath ?? f.profilePath, profilesDir: options.profilesDir ?? join(f.dir, "profiles"), stateDir: f.stateDir, request: taskText, interactive: options.interactive ?? false, manager: options.manager, lenses: options.useLenses,
    roles: {
      lenses: options.lenses ?? [],
      async lens({ lens, task }) { lensCalls.push({ lens, task }); return lens === "defeater" ? "Empty notes print nothing; criterion passes anyway" : "No consequential findings"; },
      async ask(assignment, schema) {
        calls.push(assignment);
        const { role } = assignment;
        if (role === "execute") { await execute(assignment); return parse(schema, { summary: "Development suite green" }, role); }
        if (role === "plan") return parse(schema, options.plan ? await options.plan(assignment.task as PlanTask, assignment) : plan, role);
        if (role === "route") return parse(schema, options.route?.(assignment) ?? { route: "product", reason: "Opening the note did not show its uppercase contents" }, role);
        return parse(schema, options.pick?.() ?? journey, role);
      },
    },
  });
  return { instance, calls, lensCalls, get planCalls() { return calls.filter((c) => c.role === "plan").length; } };
}
async function onlyOnce(predicate: () => boolean) {
  const end = performance.now() + 4000;
  while (!predicate() && performance.now() < end) await sleep(10);
  assert.ok(predicate(), "state transition not observed");
}

test("CLI exercises real staged candidate and records exact identity; original tree untouched", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const r = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); });
  await r.instance.done;
  const view = r.instance.view;
  assert.equal(view.state, "pass", view.activity);
  assert.equal(r.planCalls, 1);
  assert.equal(view.contract?.request, taskText);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(await readFile(join(f.repo, "app.py"), "utf8"), app);
  assert.equal(f.git("rev-parse", view.branch), view.candidate);
  assert.notEqual(f.git("rev-parse", "HEAD"), view.candidate);
  const raw = await readFile(view.receipt!.path);
  const receipt = JSON.parse(raw.toString());
  assert.equal(digest(raw), view.receipt!.digest);
  assert.equal(receipt.commit, view.candidate);
  assert.equal(receipt.artifactDigest, digest(good));
  assert.equal(receipt.observations[0].argv[1], receipt.artifact);
  assert.match(receipt.observations[0].stdout, /HELLO PRIVATE FIXTURE/);
  assert.ok(view.evidence.every((e) => e.pass));
  assert.deepEqual(Object.keys(r.calls.find((x) => x.role === "journey")!.task).sort(), ["checks", "commit", "contract", "request", "surface"]);
  assert.equal((await archived(f.stateDir, view.id, f.repo)).state, "pass");
});

test("green development checks and earlier receipts don't pass a bad user journey", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const r = run(f, async ({ cwd, selfCheck }) => {
    const dev = await runProcess("/usr/bin/true", [], { cwd, env: cleanEnv, ms: 3000, signal: AbortSignal.timeout(3000) });
    selfCheck?.(`green: exit ${dev.code}`);
  });
  await r.instance.done;
  assert.equal(r.instance.view.state, "limited", r.instance.view.activity);
  assert.equal(r.instance.view.attempt, 3);
  assert.match(JSON.stringify(r.instance.view.selfChecks), /green: exit 0/);
  assert.ok(r.instance.view.evidence.some((e) => !e.pass && e.observed.includes("old result")));
  assert.deepEqual(r.calls.map((x) => x.role), ["plan", "execute", "journey", "route", "execute", "journey", "route", "execute", "journey"]);
  assert.ok(r.calls.filter((x) => x.role === "execute").every((x) => !JSON.stringify(x.task).includes("private fixture")));
});

test("TTY observes a rendered screen after input, resize and key events", async (t) => {
  const f = await fixture("tui"); t.after(f.cleanup);
  const ttyApp = "import os,sys\nassert sys.stdin.isatty()\nprint('READY', flush=True)\nif input() == 'go':\n print('\\x1b[2J\\x1b[H'+open(sys.argv[1]).read().strip().upper(), flush=True)\ninput()\n";
  const r = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), ttyApp); });
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  assert.equal(r.instance.view.evidence[0]?.traceStep, "1.7");
  const { observations } = JSON.parse(await readFile(r.instance.view.receipt!.path, "utf8"));
  assert.match(observations[0].screens[0].screen, /READY/);
  assert.equal(observations[0].screens[1].screen, "HELLO PRIVATE FIXTURE");
});

test("wrong staged entry, installed path and unsupported coverage block", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const outside = join(f.dir, "installed.py");
  await writeFile(outside, good);
  const initial = run(f, async () => { assert.fail("uncovered contract reached Execute"); }, {
    plan: () => ({ ...plan, contract: { ...scope, criteria: [{ ...scope.criteria[0], checks: [] }] } }),
  });
  await initial.instance.done;
  assert.equal(initial.instance.view.code, "coverage");
  assert.equal(f.git("branch", "--list", "worq/*"), "");
  const wrong = run(f, async ({ cwd }) => { await rm(join(cwd, "app.py")); await symlink(outside, join(cwd, "app.py")); });
  await wrong.instance.done;
  assert.equal(wrong.instance.view.state, "blocked");
  assert.equal(wrong.instance.view.code, "path");
  assert.equal(wrong.instance.view.receipt, undefined);
  f.profile.entry = outside;
  await f.config();
  const path = run(f, async () => { assert.fail("invalid profile reached Execute"); });
  await path.instance.done;
  assert.equal(path.instance.view.code, "path");
  assert.equal(path.planCalls, 0);
});

test("consequential ambiguity pauses without a worktree; cancelled late completion cannot advance", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let resolved = false;
  const r = run(f, async ({ cwd }) => { await sleep(200); await writeFile(join(cwd, "app.py"), good); resolved = true; }, {
    plan: async (_task, { bus, signal }) => {
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
  assert.ok(!r.calls.some((c) => c.role === "journey"));
});

test("design and intent returns replan; a changed contract waits for explicit approval", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let attempts = 0;
  const r = run(f, async ({ cwd }) => { if (++attempts === 3) await writeFile(join(cwd, "app.py"), good); }, {
    plan: (task) => ({ ...plan, contract: intent(task) ? { ...scope, boundaries: ["Only stdout"] } : scope }),
    route: () => ({ route: attempts === 1 ? "design" : "intent", reason: "User-facing behavior does not match the requirement" }), interactive: true,
  });
  await onlyOnce(() => r.instance.view.state === "question");
  assert.equal(r.instance.view.attempt, 3);
  assert.deepEqual(r.instance.view.proposedContract?.boundaries, ["Only stdout"]);
  assert.equal(r.instance.answer("Y"), true);
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  assert.equal(r.planCalls, 3);
  assert.equal(r.instance.view.contract?.request, taskText);
});

test("typed contract changes revise the proposal; endless rejection blocks", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let attempts = 0;
  const revisions: string[] = [];
  const r = run(f, async ({ cwd }) => { if (++attempts === 2) await writeFile(join(cwd, "app.py"), good); }, {
    plan: (task) => {
      if (task.revision) revisions.push(task.revision);
      return { ...plan, contract: task.revision ? { ...scope, assumptions: ["Revised"] } : intent(task) ? { ...scope, boundaries: ["Only stdout"] } : scope };
    },
    route: () => ({ route: "intent", reason: "Mismatch" }), interactive: true,
  });
  await onlyOnce(() => r.instance.view.state === "question");
  assert.equal(r.instance.answer("Also keep stderr empty"), true);
  await onlyOnce(() => r.instance.view.state === "question" && r.instance.view.proposedContract?.assumptions[0] === "Revised");
  assert.equal(r.instance.answer("approve"), true);
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  assert.deepEqual(revisions, ["Also keep stderr empty"]);
  assert.deepEqual(r.instance.view.contract?.assumptions, ["Revised"]);

  const stubborn = run(f, async () => {}, {
    plan: (task) => ({ ...plan, contract: { ...scope, boundaries: [task.revision ?? (intent(task) ? "Only stdout" : "none")] } }),
    route: () => ({ route: "intent", reason: "Mismatch" }), interactive: true,
  });
  for (const reply of ["no", "still no", "never"]) {
    await onlyOnce(() => stubborn.instance.view.state === "question");
    assert.equal(stubborn.instance.answer(reply), true);
    await onlyOnce(() => stubborn.instance.view.state !== "question" || stubborn.instance.view.proposedContract?.boundaries[0] === reply);
  }
  await stubborn.instance.done;
  assert.equal(stubborn.instance.view.code, "contract-unapproved");
});

test("profile is discovered by repository; ambiguity is named", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const dir = join(f.dir, "found");
  await mkdir(dir);
  await writeFile(join(dir, "other.json"), JSON.stringify({ ...f.profile, repository: f.dir }), { mode: 0o600 });
  await writeFile(join(dir, "mine.json"), JSON.stringify(f.profile), { mode: 0o600 });
  const found = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); }, { profilePath: "", profilesDir: dir });
  await found.instance.done;
  assert.equal(found.instance.view.state, "pass", found.instance.view.activity);
  await writeFile(join(dir, "copy.json"), JSON.stringify(f.profile), { mode: 0o600 });
  const twice = run(f, async () => { assert.fail(); }, { profilePath: "", profilesDir: dir });
  await twice.instance.done;
  assert.equal(twice.instance.view.code, "profile-ambiguous");
});

test("missing profile, dirty baseline and missing journey coverage are named blockers", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const unconfigured = run(f, async () => { assert.fail(); }, { profilePath: "" });
  await unconfigured.instance.done;
  assert.equal(unconfigured.instance.view.code, "no-profile");
  await writeFile(join(f.repo, "dirty"), "input");
  const dirty = run(f, async () => { assert.fail(); });
  await dirty.instance.done;
  assert.equal(dirty.instance.view.code, "dirty-baseline");
  assert.equal(dirty.planCalls, 0);
  await rm(join(f.repo, "dirty"));
  const unsupported = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); }, { pick: () => ({ cases: [], blocker: "Does not exercise invalid notes" }) });
  await unsupported.instance.done;
  assert.equal(unsupported.instance.view.code, "journey-blocked");
  assert.equal(unsupported.instance.view.receipt, undefined);
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

test("manager reviews handoffs: plan and candidate revisions loop once; Verify stays private", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let executions = 0;
  const r = run(f, async ({ cwd }) => { if (++executions === 2) await writeFile(join(cwd, "app.py"), good); }, { manager: true, interactive: true });
  const decide = async (gate: string, decision: "approve" | "revise", text?: string) => {
    await onlyOnce(() => r.instance.bus?.pendingView().some((p) => p.gate === gate) ?? false);
    const pending = r.instance.bus!.pendingView().find((p) => p.gate === gate)!;
    assert.match(r.instance.view.activity, new RegExp(`Waiting on Pi · ${gate} review`));
    r.instance.bus!.review(pending.id, decision, text);
    return pending;
  };
  const planGate = await decide("plan", "revise", "Also cover empty notes");
  assert.match(planGate.body, /Edit app.py/);
  assert.match(planGate.body, /Outcome: Show the loaded input uppercased/);
  const candidate = await decide("candidate", "revise", "Uppercase is still missing");
  assert.match(candidate.body, /Development suite green/);
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  const plans = r.calls.filter((c) => c.role === "plan");
  assert.equal(plans.length, 2);
  assert.equal((plans[1].task as { review?: string }).review, "Also cover empty notes");
  assert.equal((r.calls.filter((c) => c.role === "execute")[1].task as { review?: string }).review, "Uppercase is still missing");
  assert.deepEqual(Object.keys(r.calls.find((x) => x.role === "journey")!.task).sort(), ["checks", "commit", "contract", "request", "surface"]);
  assert.ok(r.instance.view.path.some((step) => step === "1 · plan review: revise"));
});

test("without an attached manager, gates auto-approve and record nothing", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const r = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); });
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass");
  assert.ok(!r.instance.view.path.some((step) => step.includes("review")));
});

test("lenses auto-fire on the finished plan; Pi reopens Plan with their findings or discards them", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const r = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); }, { manager: true, interactive: true, lenses: ["pair", "defeater"] });
  await onlyOnce(() => r.instance.bus?.pendingView().some((p) => p.gate === "plan") ?? false);
  const gate = r.instance.bus!.pendingView().find((p) => p.gate === "plan")!;
  assert.match(gate.body, /Lens findings[\s\S]*\[pair\] No consequential findings[\s\S]*\[defeater\] Empty notes/);
  assert.deepEqual(r.lensCalls.map((c) => c.lens), ["pair", "defeater"]);
  assert.deepEqual(Object.keys(r.lensCalls[0].task).sort(), ["contract", "plan", "request"]);
  r.instance.bus!.review(gate.id, "revise", "Resolve the defeater finding");
  await onlyOnce(() => r.instance.bus?.pendingView().some((p) => p.gate === "candidate") ?? false);
  r.instance.bus!.review(r.instance.bus!.pendingView().find((p) => p.gate === "candidate")!.id, "approve");
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  const plans = r.calls.filter((c) => c.role === "plan").map((c) => c.task as PlanTask);
  assert.equal(plans.length, 2);
  assert.match(plans[1].lensFindings ?? "", /\[defeater\] Empty notes/);
  assert.equal(r.lensCalls.length, 2, "lenses run once per plan stage, not on the reopened plan");
  assert.deepEqual(r.instance.view.jobs.map((j) => [j.kind, j.state]), [["lens:pair", "done"], ["lens:defeater", "done"]]);

  const off = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); }, { lenses: ["pair"] });
  await off.instance.done;
  assert.equal(off.lensCalls.length, 0);
  assert.ok(off.instance.view.path.includes("1 · lenses skipped: no Pi plan review"));
  const disabled = run(f, async ({ cwd }) => { await writeFile(join(cwd, "app.py"), good); }, { manager: true, lenses: ["pair"], useLenses: false });
  for (const kind of ["plan", "candidate"]) {
    await onlyOnce(() => disabled.instance.bus?.pendingView().some((p) => p.gate === kind) ?? false);
    const pending = disabled.instance.bus!.pendingView().find((p) => p.gate === kind)!;
    if (kind === "plan") assert.doesNotMatch(pending.body, /Lens findings/);
    disabled.instance.bus!.review(pending.id, "approve");
  }
  await disabled.instance.done;
  assert.equal(disabled.lensCalls.length, 0);
});
