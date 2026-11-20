import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { parse, type Contract, type Profile } from "../src/contracts.ts";
import { archived, Run, type Assignment, type Roles } from "../src/controller.ts";
import { cleanEnv, launch, runProcess } from "../src/process.ts";
import { digest } from "../src/workspace.ts";

const app = `import sys\nprint('old result')\n`;
const good = `import sys\nprint(open(sys.argv[1]).read().strip().upper())\n`;
const contract: Contract = { outcome: "Show the loaded input uppercased", assumptions: [], boundaries: [], criteria: [{ id: "uppercase", outcome: "Fixture contents are printed in uppercase", checks: ["show"] }] };
const taskText = "Make loading a note print its contents in uppercase";

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
const plan = { summary: "Change formatting", steps: ["Edit app.py"] };
const journey = { cases: [{ check: "show", scenario: "sample" }] };
function run(f: Fixture, execute: (assignment: Assignment) => Promise<void>, options: {
  orient?: Roles["orient"]; route?: (assignment: Assignment) => object; interactive?: boolean; profilePath?: string; pick?: () => object;
} = {}) {
  const calls: Assignment[] = [];
  let orientationCalls = 0;
  const instance = new Run({ cwd: f.repo, profilePath: options.profilePath ?? f.profilePath, stateDir: f.stateDir, request: taskText, interactive: options.interactive ?? false,
    roles: {
      orient: async (task, profile, signal) => { orientationCalls++; return options.orient ? options.orient(task, profile, signal) : { contract }; },
      async ask(assignment, schema) {
        calls.push(assignment);
        const { role } = assignment;
        if (role === "execute") { await execute(assignment); return parse(schema, { summary: "Development suite green" }, role); }
        if (role === "plan") return parse(schema, plan, role);
        if (role === "route") return parse(schema, options.route?.(assignment) ?? { route: "product", reason: "Opening the note did not show its uppercase contents" }, role);
        return parse(schema, options.pick?.() ?? journey, role);
      },
    },
  });
  return { instance, calls, get orientationCalls() { return orientationCalls; } };
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
  assert.equal(r.orientationCalls, 1);
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
    orient: async () => ({ contract: { ...contract, criteria: [{ ...contract.criteria[0], checks: [] }] } }),
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
  assert.equal(path.orientationCalls, 0);
});

test("consequential ambiguity pauses without a worktree; cancelled late completion cannot advance", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  let resolved = false;
  const r = run(f, async ({ cwd }) => { await sleep(200); await writeFile(join(cwd, "app.py"), good); resolved = true; }, {
    orient: async (task) => "answer" in task ? { contract } : { question: "Which result should the note show?" }, interactive: true,
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
    orient: async (task) => ({ contract: "feedback" in task ? { ...contract, boundaries: ["Only stdout"] } : contract }),
    route: () => ({ route: attempts === 1 ? "design" : "intent", reason: "User-facing behavior does not match the requirement" }), interactive: true,
  });
  await onlyOnce(() => r.instance.view.state === "question");
  assert.equal(r.instance.view.attempt, 3);
  assert.deepEqual(r.instance.view.proposedContract?.boundaries, ["Only stdout"]);
  assert.equal(r.instance.answer("approve"), true);
  await r.instance.done;
  assert.equal(r.instance.view.state, "pass", r.instance.view.activity);
  assert.equal(r.calls.filter((x) => x.role === "plan").length, 3);
  assert.equal(r.orientationCalls, 2);
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
  assert.equal(dirty.orientationCalls, 0);
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
