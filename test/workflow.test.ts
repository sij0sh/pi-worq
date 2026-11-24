import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentDock } from "../src/dock.ts";
import { Telemetry } from "../src/telemetry.ts";
import { skillTool } from "../src/runtime/resources.ts";
import { loadCatalog, loadWorkflows, provision, SEEDED, SEEDS } from "../src/runtime/workflows.ts";
import type { Worq } from "../src/worq.ts";
import { KINDS, pass, planSubmission, repo, setup, type Turn } from "./fake.ts";

function skillFile(options: { name?: string; access?: string; description?: string; disable?: string; extra?: string[]; body?: string } = {}) {
  const lines = ["---"];
  if (options.name !== undefined) lines.push(`name: ${options.name}`);
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  if (options.access !== undefined) lines.push(`access: ${options.access}`);
  if (options.disable !== undefined) lines.push(`disable-model-invocation: ${options.disable}`);
  lines.push(...(options.extra ?? []), "---", "");
  return `${lines.join("\n")}${options.body ?? "Inspect the repository and submit the result.\n"}`;
}
const workflowFile = (options: Parameters<typeof skillFile>[0] = {}) => skillFile(options);

/** `<agentDir>/workflows/<entry>`: a string value is `<entry>/SKILL.md`; `{ file }` is a flat file; extra paths are package files. */
async function agentDir(t: { after(callback: () => unknown): void }, entries: Record<string, string | { file: string } | Record<string, string>>) {
  const dir = await mkdtemp(join(tmpdir(), "worq-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workflows = join(dir, "workflows");
  await mkdir(workflows);
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === "object" && "file" in value && typeof value.file === "string" && Object.keys(value).length === 1) { await writeFile(join(workflows, name), value.file); continue; }
    const files = typeof value === "string" ? { "SKILL.md": value } : value as Record<string, string>;
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(workflows, name, rel)), { recursive: true });
      await writeFile(join(workflows, name, rel), text);
    }
    if (!Object.keys(files).length) await mkdir(join(workflows, name), { recursive: true });
  }
  return dir;
}

/** The shipped packages plus the ones the loader returns from a fixture profile. */
function userKinds(dir: string) {
  const loaded = loadWorkflows(dir);
  return { ...loaded, kinds: new Map([...KINDS, ...loaded.kinds]) };
}
const userLaunch = (worq: Worq, kind: string, task?: string) => worq.launch({ kind, task }, { caller: "user" });

test("workflow loader: a missing directory is an empty installation", () => {
  const { kinds, problems } = loadWorkflows("/nonexistent/worq");
  assert.equal(kinds.size, 0);
  assert.deepEqual(problems, []);
});

test("workflow loader: skill packages with standard frontmatter; access defaults to write, read is explicit", async (t) => {
  const dir = await agentDir(t, {
    audit: { "SKILL.md": skillFile({ name: "audit", description: "Audit it", access: "read" }), "references/table.md": "| a |", "scripts/run.sh": "echo" },
    change: skillFile({ description: "Change it" }),
    private: skillFile({ description: "Mine", disable: "true" }),
    quoted: skillFile({ name: '"quoted"', description: "'Quoted'", disable: "false" }),
    reviewed: skillFile({ description: "Reviewed", extra: ["review: true"] }),
  });
  const { kinds, problems } = loadWorkflows(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual([...kinds.keys()], ["audit", "change", "private", "quoted", "reviewed"]);
  const audit = kinds.get("audit")!;
  assert.equal(audit.access, "read");
  assert.equal(audit.description, "Audit it");
  assert.match(audit.prompt, /^Inspect the repository/);
  assert.deepEqual(audit.skill?.files, ["references/table.md", "scripts/run.sh"]);
  assert.equal(audit.userOnly, false);
  assert.ok(!("review" in audit), "every agent is reviewed once; a review key is ignored");
  assert.equal(kinds.get("change")!.access, "write");
  assert.equal(kinds.get("private")!.userOnly, true);
  assert.equal(kinds.get("quoted")!.description, "Quoted");
});

test("workflow loader: the documented example loads", async () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "examples");
  const dir = await mkdtemp(join(tmpdir(), "worq-example-"));
  try {
    await mkdir(join(dir, "workflows"));
    await symlink(join(example, "foundation"), join(dir, "workflows", "linked"));
    const { problems: linked } = loadWorkflows(dir);
    assert.match(linked[0]?.message ?? "", /symlinked workflows are not followed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const copy = await mkdtemp(join(tmpdir(), "worq-example-"));
  try {
    const { cp } = await import("node:fs/promises");
    await cp(join(example, "foundation"), join(copy, "workflows", "foundation"), { recursive: true });
    const loaded = loadWorkflows(copy);
    assert.deepEqual(loaded.problems, []);
    const foundation = loaded.kinds.get("foundation")!;
    assert.equal(foundation.access, "read");
    assert.equal(foundation.userOnly, false);
    assert.ok(foundation.skill?.files.includes("references/capabilities.md"));
  } finally { await rm(copy, { recursive: true, force: true }); }
});

test("workflow loader: per-folder defects are named and skipped; valid siblings still load", async (t) => {
  const dir = await agentDir(t, {
    "audit-": skillFile({ description: "x" }),
    "Audit": skillFile({ description: "x" }),
    plan: skillFile({ description: "No reserved names" }),
    empty: {},
    mismatch: skillFile({ name: "other", description: "x" }),
    nodesc: skillFile(),
    disable: skillFile({ description: "x", disable: "yes" }),
    access: skillFile({ description: "x", access: "admin" }),
    reviewed: skillFile({ description: "x", extra: ["review: maybe"] }),
    blank: skillFile({ description: "x", body: "" }),
    "legacy.md": { file: skillFile({ description: "x" }) },
    fine: skillFile({ description: "Fine" }),
    ".hidden": skillFile({ description: "x" }),
    "README.md": { file: "junk" },
    "notes.txt": { file: "junk" },
  });
  const { kinds, problems } = loadWorkflows(dir);
  assert.deepEqual([...kinds.keys()], ["fine", "plan", "reviewed"], "a review key is ignored");
  const message = (name: string) => problems.find((p) => p.path.split(sep).join("/").endsWith(`/${name}`))?.message ?? "";
  assert.match(message("audit-"), /folder name must be lowercase/);
  assert.match(message("Audit"), /folder name must be lowercase/);
  assert.match(message("empty"), /add SKILL\.md/);
  assert.match(message("mismatch"), /name "other" must match the folder name "mismatch"/);
  assert.match(message("nodesc"), /description is required/);
  assert.match(message("disable"), /disable-model-invocation must be true or false/);
  assert.match(message("access"), /access must be read or write/);
  assert.match(message("blank"), /body is blank/);
  assert.match(message("legacy.md"), /move to .*legacy\/SKILL\.md/);
  assert.equal(problems.length, 9);
});

test("skill tool: reads a package's listed files, nothing else", async (t) => {
  const dir = await agentDir(t, { audit: { "SKILL.md": skillFile({ description: "Audit", access: "read" }), "references/table.md": "TABLE" } });
  const outside = join(dir, "secret.md");
  await writeFile(outside, "SECRET");
  const skill = loadWorkflows(dir).kinds.get("audit")!.skill!;
  const read = skillTool([skill])!;
  assert.equal(await read.run({ name: "audit" }, AbortSignal.timeout(1000)), skill.body);
  assert.equal(await read.run({ name: "audit", path: "references/table.md" }, AbortSignal.timeout(1000)), "TABLE");
  assert.throws(() => read.run({ name: "audit", path: "../secret.md" }, AbortSignal.timeout(1000)), /has no file/);
  assert.throws(() => read.run({ name: "audit", path: "SKILL.md" }, AbortSignal.timeout(1000)), /has no file/);
});

test("model-invocable workflows spawn like kinds; user-only ones and review options are refused", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, {
    documentation: workflowFile({ access: "read", description: "Write docs" }),
    private: workflowFile({ access: "read", description: "Mine", disable: "true" }),
  });
  const { kinds } = userKinds(agentDirPath);
  let skills: string[] = [];
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => { skills = (turn.spec.skills ?? []).map((s) => s.name); await turn.tool("submit", planSubmission); },
  }, {}, undefined, kinds);
  await assert.rejects(worq.spawn("private", "x", { title: "Write docs" }), /user-only[\s\S]*\/worq/);
  await assert.rejects(worq.spawn("nope", "x", { title: "Write docs" }), /Unknown kind nope; installed: execute \| plan \| documentation/);
  const agent = await worq.spawn("documentation", "Write the CLI docs", { title: "Write docs" });
  assert.equal(agent.ref, "write-docs");
  await next("parked", agent.ref);
  assert.deepEqual(skills, ["documentation"], "the workflow's own package is readable through the skill tool");
  await worq.cancel(agent.ref);
});

test("a user launch generates a readable title and uses either the written task or the user's direction", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs" }) });
  const { kinds } = userKinds(agentDirPath);
  const tasks: string[] = [];
  const telemetry = new Telemetry();
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => {
      tasks.push(JSON.parse(turn.text).task);
      await turn.tool("submit", planSubmission);
    },
  }, {}, telemetry, kinds);
  const agent = await userLaunch(worq, "documentation");
  assert.equal(agent.ref, "documentation-run");
  assert.equal(agent.title, "documentation run");
  const theme = { fg: (_: string, value: string) => value } as never;
  const dock = agentDock(telemetry, theme, () => false, () => {}, () => {}, () => 24);
  assert.match(dock.render(96)[2]!, /^ ● documentation: documentation run\s/);
  assert.match(dock.render(34)[2]!, /^documentation: documentation run/);
  assert.equal(agent.task, "Run the documentation workflow on this repository and submit its result.");
  await next("parked", agent.ref);
  await worq.cancel(agent.ref);
  const directed = await userLaunch(worq, "documentation", "  Focus on the CLI reference.  ");
  assert.equal(directed.ref, "focus-on-the-cli");
  assert.equal(directed.task, "Focus on the CLI reference.");
  await next("parked", directed.ref);
  await worq.cancel(directed.ref);
  assert.deepEqual(tasks, [
    "Run the documentation workflow on this repository and submit its result.",
    "Focus on the CLI reference.",
  ]);
});

test("a running workflow is listable, steerable and cancellable", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs" }) });
  const { kinds } = userKinds(agentDirPath);
  const { worq } = setup(root, state, { "agent.documentation": async () => { await new Promise<void>(() => {}); } }, {}, undefined, kinds);
  const agent = await userLaunch(worq, "documentation");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(worq.list(), /documentation-run/);
  assert.match(worq.list(agent.ref), /Task: Run the documentation workflow/);
  assert.match(worq.send(agent.ref, "Focus on the CLI reference"), /Steered documentation-run/);
  await worq.cancel(agent.ref);
  assert.equal(agent.state, "cancelled");
  assert.ok(agent.ended);
});

test("read package: plan artifact and exactly one review", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs" }) });
  const { kinds } = userKinds(agentDirPath);
  let system = "";
  let finish = "";
  const { worq, next, seen } = setup(root, state, {
    "agent.documentation": async (turn) => {
      system = turn.system;
      finish = turn.spec.tools.find((tool) => tool.name === "submit")!.description;
      await turn.tool("submit", planSubmission);
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, {}, undefined, kinds);
  const agent = await userLaunch(worq, "documentation");
  const ready = await next("parked", agent.ref);
  assert.match(system, /One independent review checks your first submission/);
  assert.match(finish, /^Submit your result\. Worq saves it to \.agents\/plans\/\./);
  assert.equal(seen.filter((spec) => spec.name === "review").length, 1);
  assert.equal(agent.review?.verdict, "pass");
  assert.match(ready.text, /parked · no review issues reported/);
  assert.equal(agent.plan?.path, ".agents/plans/plan-documentation-run.md");
  assert.match(await readFile(join(root, agent.plan!.path), "utf8"), /^# Plan: documentation run\n/);
  await worq.cancel(agent.ref);
});

test("write package pins worq/<ref>, never merges, and gets one review of the exact commit", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "change-log": workflowFile({ access: "write", description: "Change the log" }) });
  const { kinds } = userKinds(agentDirPath);
  let system = "";
  let finish = "";
  const { worq, next, seen } = setup(root, state, {
    "agent.change-log": async (turn: Turn) => {
      system = turn.system;
      finish = turn.spec.tools.find((tool) => tool.name === "submit")!.description;
      await turn.tool("write_file", { path: "app.py", content: "print('CHANGED')\n" });
      await turn.tool("submit", { summary: "Changed the greeting", report: "Changes: app.py" });
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, {}, undefined, kinds);
  const agent = await userLaunch(worq, "change-log");
  assert.equal(agent.ref, "change-log-run");
  assert.equal(agent.branch, "worq/change-log-run");
  const ready = await next("parked", agent.ref);
  assert.match(system, /One independent review checks your first submission/);
  assert.match(finish, /^Submit your result\. Ends your turn\.$/);
  assert.equal(seen.filter((spec) => spec.name === "review").length, 1);
  assert.match(ready.text, new RegExp(`Branch worq/${agent.ref}`));
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('hello')\n", "no merge");
  assert.equal(agent.state, "parked");
  await worq.cancel(agent.ref);
  assert.equal(agent.work, undefined, "closing removed its worktree");
  git("rev-parse", "--verify", `worq/${agent.ref}`);
});

test("a review key cannot opt out; a parked package releases capacity", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs", extra: ["review: false"] }) });
  const { kinds } = userKinds(agentDirPath);
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => { await turn.tool("submit", planSubmission); },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, {}, undefined, kinds);
  const agent = await userLaunch(worq, "documentation");
  const ready = await next("parked", agent.ref);
  assert.match(ready.text, /parked · no review issues reported/);
  assert.equal(agent.review?.verdict, "pass");
  assert.equal(worq.all().filter(a => a.active).length, 0);
  await worq.cancel(agent.ref);
});

test("an invalid workflow file does not affect a successful plan spawn", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, {
    broken: workflowFile({ access: "read" }),
    documentation: workflowFile({ access: "read", description: "Write docs" }),
  });
  const { kinds, problems } = userKinds(agentDirPath);
  assert.equal(problems.length, 1);
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => { await turn.tool("submit", planSubmission); },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, {}, undefined, kinds);
  const plan = await worq.spawn("plan", "Plan the greeting", { title: "Plan the greeting" });
  await next("parked", plan.ref);
  assert.equal(plan.state, "parked");
  await worq.cancel(plan.ref);
  assert.equal(worq.list(plan.ref).includes("closed"), true);
});

test("defaults: first use installs Plan and Execute once; edits and deletions survive reloads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-seed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = loadCatalog(dir);
  assert.deepEqual(first.problems, []);
  assert.deepEqual([...first.kinds.keys()], ["execute", "plan"]);
  assert.equal(await readFile(join(dir, "workflows", "plan", "SKILL.md"), "utf8"), await readFile(join(SEEDS, "plan", "SKILL.md"), "utf8"));
  assert.ok(existsSync(join(dir, "workflows", SEEDED)));
  assert.ok(!readdirSync(join(dir, "workflows")).some((entry) => entry.startsWith(".seed-")), "no staging left behind");
  await writeFile(join(dir, "workflows", "plan", "SKILL.md"), "---\ndescription: My plan\naccess: read\n---\nMine.\n");
  await rm(join(dir, "workflows", "execute"), { recursive: true });
  const again = loadCatalog(dir);
  assert.deepEqual([...again.kinds.keys()], ["plan"], "a deleted package stays deleted");
  assert.equal(again.kinds.get("plan")!.description, "My plan", "edits survive");
  await rm(join(dir, "workflows"), { recursive: true });
  assert.deepEqual([...loadCatalog(dir).kinds.keys()], ["execute", "plan"], "a fresh profile is seeded again");
});

test("defaults: a differing folder with a shipped name is withheld until resolved; identical ones count as installed", async (t) => {
  const dir = await agentDir(t, { plan: skillFile({ description: "Someone else's plan", access: "write" }), custom: skillFile({ description: "Custom" }) });
  const conflicted = loadCatalog(dir);
  assert.deepEqual([...conflicted.kinds.keys()], ["custom", "execute"], "other folders still load");
  assert.match(conflicted.problems.find((p) => p.path.endsWith(`${sep}plan`))?.message ?? "", /differs from the shipped "plan" package[\s\S]*Move it aside/);
  assert.ok(!existsSync(join(dir, "workflows", SEEDED)), "not marked complete");
  assert.match(await readFile(join(dir, "workflows", "plan", "SKILL.md"), "utf8"), /Someone else's plan/, "never overwritten");
  await rename(join(dir, "workflows", "plan"), join(dir, "plan-mine"));
  const resolved = loadCatalog(dir);
  assert.deepEqual([...resolved.kinds.keys()], ["custom", "execute", "plan"]);
  assert.deepEqual(resolved.problems, []);
  assert.ok(existsSync(join(dir, "workflows", SEEDED)));

  // A concurrent or retried start that finds exact intact seeds completes without rewriting them.
  const copy = await mkdtemp(join(tmpdir(), "worq-seed-copy-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(join(SEEDS, "plan"), join(copy, "workflows", "plan"), { recursive: true });
  provision(copy); provision(copy);
  assert.deepEqual([...loadCatalog(copy).kinds.keys()], ["execute", "plan"]);
  assert.ok(existsSync(join(copy, "workflows", SEEDED)));
});

test("defaults: an unwritable profile reports a problem and still loads what exists", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions" : false }, async (t) => {
  const dir = await agentDir(t, { custom: skillFile({ description: "Custom" }) });
  await chmod(join(dir, "workflows"), 0o500);
  let catalog: ReturnType<typeof loadCatalog>;
  try { catalog = loadCatalog(dir); } finally { await chmod(join(dir, "workflows"), 0o700); }
  assert.deepEqual([...catalog.kinds.keys()], ["custom"]);
  assert.match(catalog.problems[0]?.message ?? "", /Default packages not installed[\s\S]*Copy/);
});
