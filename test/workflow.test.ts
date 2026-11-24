import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentDock } from "../src/dock.ts";
import { loadPrompts } from "../src/prompts.ts";
import { Telemetry } from "../src/telemetry.ts";
import { skillTool } from "../src/runtime/resources.ts";
import { loadWorkflows } from "../src/runtime/workflows.ts";
import { pass, planSubmission, repo, setup, type Turn } from "./fake.ts";

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

/** Base prompts plus the workflow kinds the loader returns. */
function userPrompts(dir: string) {
  const prompts = loadPrompts();
  const loaded = loadWorkflows(dir, prompts.kinds);
  for (const [name, kind] of loaded.kinds) prompts.kinds.set(name, kind);
  return { prompts, ...loaded };
}

test("workflow loader: a missing directory is an empty installation", () => {
  const { kinds, problems } = loadWorkflows("/nonexistent/worq", loadPrompts().kinds);
  assert.equal(kinds.size, 0);
  assert.deepEqual(problems, []);
});

test("workflow loader: skill packages with standard frontmatter; access defaults to write, read is explicit", async (t) => {
  const dir = await agentDir(t, {
    audit: { "SKILL.md": skillFile({ name: "audit", description: "Audit it", access: "read" }), "references/table.md": "| a |", "scripts/run.sh": "echo" },
    change: skillFile({ description: "Change it" }),
    private: skillFile({ description: "Mine", disable: "true" }),
    quoted: skillFile({ name: '"quoted"', description: "'Quoted'", disable: "false" }),
  });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts().kinds);
  assert.deepEqual(problems, []);
  assert.deepEqual([...kinds.keys()], ["audit", "change", "private", "quoted"]);
  const audit = kinds.get("audit")!;
  assert.equal(audit.access, "read");
  assert.equal(audit.description, "Audit it");
  assert.match(audit.prompt, /^Inspect the repository/);
  assert.deepEqual(audit.workflow?.skill.files, ["references/table.md", "scripts/run.sh"]);
  assert.equal(audit.workflow?.userOnly, false);
  assert.equal(kinds.get("change")!.access, "write");
  assert.equal(kinds.get("private")!.workflow?.userOnly, true);
  assert.equal(kinds.get("quoted")!.description, "Quoted");
});

test("workflow loader: the documented example loads", async () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "examples");
  const prompts = loadPrompts();
  const dir = await mkdtemp(join(tmpdir(), "worq-example-"));
  try {
    await mkdir(join(dir, "workflows"));
    await symlink(join(example, "foundation"), join(dir, "workflows", "linked"));
    const { problems: linked } = loadWorkflows(dir, prompts.kinds);
    assert.match(linked[0]?.message ?? "", /symlinked workflows are not followed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const copy = await mkdtemp(join(tmpdir(), "worq-example-"));
  try {
    const { cp } = await import("node:fs/promises");
    await cp(join(example, "foundation"), join(copy, "workflows", "foundation"), { recursive: true });
    const loaded = loadWorkflows(copy, prompts.kinds);
    assert.deepEqual(loaded.problems, []);
    const foundation = loaded.kinds.get("foundation")!;
    assert.equal(foundation.access, "read");
    assert.equal(foundation.workflow?.userOnly, false);
    assert.ok(foundation.workflow?.skill.files.includes("references/capabilities.md"));
  } finally { await rm(copy, { recursive: true, force: true }); }
});

test("workflow loader: per-folder defects are named and skipped; valid siblings still load", async (t) => {
  const dir = await agentDir(t, {
    "audit-": skillFile({ description: "x" }),
    "Audit": skillFile({ description: "x" }),
    plan: skillFile({ description: "Collides" }),
    empty: {},
    mismatch: skillFile({ name: "other", description: "x" }),
    nodesc: skillFile(),
    disable: skillFile({ description: "x", disable: "yes" }),
    access: skillFile({ description: "x", access: "admin" }),
    reviewed: skillFile({ description: "x", extra: ["reviewers: plan"] }),
    invoked: skillFile({ description: "x", extra: ["invocation: user"] }),
    blank: skillFile({ description: "x", body: "" }),
    "legacy.md": { file: skillFile({ description: "x" }) },
    fine: skillFile({ description: "Fine" }),
    ".hidden": skillFile({ description: "x" }),
    "README.md": { file: "junk" },
    "notes.txt": { file: "junk" },
  });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts().kinds);
  assert.deepEqual([...kinds.keys()], ["fine"]);
  const message = (name: string) => problems.find((p) => p.path.endsWith(`/${name}`))?.message ?? "";
  assert.match(message("audit-"), /folder name must be lowercase/);
  assert.match(message("Audit"), /folder name must be lowercase/);
  assert.match(message("plan"), /"plan" is a built-in kind/);
  assert.match(message("empty"), /add SKILL\.md/);
  assert.match(message("mismatch"), /name "other" must match the folder name "mismatch"/);
  assert.match(message("nodesc"), /description is required/);
  assert.match(message("disable"), /disable-model-invocation must be true or false/);
  assert.match(message("access"), /access must be read or write/);
  assert.match(message("reviewed"), /workflows run no reviewers/);
  assert.match(message("invoked"), /disable-model-invocation: true/);
  assert.match(message("blank"), /body is blank/);
  assert.match(message("legacy.md"), /move to .*legacy\/SKILL\.md/);
  assert.equal(problems.length, 12);
});

test("skill tool: reads a package's listed files, nothing else", async (t) => {
  const dir = await agentDir(t, { audit: { "SKILL.md": skillFile({ description: "Audit", access: "read" }), "references/table.md": "TABLE" } });
  const outside = join(dir, "secret.md");
  await writeFile(outside, "SECRET");
  const skill = loadWorkflows(dir, loadPrompts().kinds).kinds.get("audit")!.workflow!.skill;
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
  const { prompts } = userPrompts(agentDirPath);
  let skills: string[] = [];
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => { skills = (turn.spec.skills ?? []).map((s) => s.name); await turn.tool("submit", planSubmission); },
  }, {}, undefined, prompts);
  await assert.rejects(worq.spawn("private", "x", { title: "Write docs" }), /user-only workflow[\s\S]*\/worq workflow/);
  await assert.rejects(worq.spawn("nope", "x", { title: "Write docs" }), /Unknown kind nope; use execute \| plan \| documentation/);
  await assert.rejects(worq.spawn("documentation", "x", { title: "Write docs", mode: "fast" }), /do not apply to workflows/);
  await assert.rejects(worq.spawn("documentation", "x", { title: "Write docs", verify: true }), /do not apply to workflows/);
  await assert.rejects(worq.runWorkflow(prompts.kinds.get("plan")!, "Write docs"), /is a built-in kind; launch it with worq_spawn/);
  const agent = await worq.spawn("documentation", "Write the CLI docs", { title: "Write docs" });
  assert.equal(agent.ref, "write-docs");
  await next("review-ready", agent.ref);
  assert.deepEqual(skills, ["documentation"], "the workflow's own package is readable through the skill tool");
  assert.deepEqual(agent.reviews, []);
  await worq.cancel(agent.ref);
});

test("runWorkflow uses the workflow ref and either the written task or the user's direction", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs" }) });
  const { prompts } = userPrompts(agentDirPath);
  const tasks: string[] = [];
  const telemetry = new Telemetry();
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => {
      tasks.push(JSON.parse(turn.text).task);
      await turn.tool("submit", planSubmission);
    },
  }, {}, telemetry, prompts);
  const kind = prompts.kinds.get("documentation")!;
  const agent = await worq.runWorkflow(kind);
  assert.equal(agent.ref, "documentation-workflow");
  assert.equal(agent.title, "documentation");
  const theme = { fg: (_: string, value: string) => value } as never;
  const dock = agentDock(telemetry, theme, () => false, () => {}, () => {}, () => 24);
  assert.match(dock.render(96)[2]!, /^ ● Workflow : documentation\s/);
  assert.match(dock.render(34)[2]!, /^Workflow : documentation (?!documentation)/);
  assert.equal(agent.task, "Run the documentation workflow on this repository and submit its result.");
  await next("review-ready", agent.ref);
  await worq.cancel(agent.ref);
  const directed = await worq.runWorkflow(kind, "  Focus on the CLI reference.  ");
  assert.equal(directed.ref, "documentation-workflow-2");
  assert.equal(directed.task, "Focus on the CLI reference.");
  await next("review-ready", directed.ref);
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
  const { prompts } = userPrompts(agentDirPath);
  const { worq } = setup(root, state, { "agent.documentation": async () => { await new Promise<void>(() => {}); } }, {}, undefined, prompts);
  const agent = await worq.runWorkflow(prompts.kinds.get("documentation")!);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(worq.list(), /documentation-workflow/);
  assert.match(worq.list(agent.ref), /Task: Run the documentation workflow/);
  assert.match(worq.send(agent.ref, "Focus on the CLI reference"), /Steered documentation-workflow/);
  await worq.cancel(agent.ref);
  assert.equal(agent.state, "cancelled");
  assert.ok(agent.ended);
});

test("read workflow: Workflow result artifact, no reviewers, no-reviewer notes", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs" }) });
  const { prompts } = userPrompts(agentDirPath);
  let system = "";
  let finish = "";
  const { worq, next, seen } = setup(root, state, {
    "agent.documentation": async (turn) => {
      system = turn.system;
      finish = turn.spec.tools.find((tool) => tool.name === "submit")!.description;
      await turn.tool("submit", planSubmission);
    },
  }, {}, undefined, prompts);
  const agent = await worq.runWorkflow(prompts.kinds.get("documentation")!);
  const ready = await next("review-ready", agent.ref);
  assert.match(system, /No independent reviewers run for this workflow; submit a self-contained result\./);
  assert.match(finish, /^Submit your result\. Worq saves it to \.agents\/plans\/\./);
  assert.doesNotMatch(finish, /for independent review/);
  assert.ok(!seen.some((spec) => spec.name.startsWith("reviewer.")));
  assert.deepEqual(agent.reviews, []);
  assert.equal(agent.reviewPolicyLabel, "none (workflow)");
  assert.match(ready.text, /No reviewers ran: this result is unverified\./);
  assert.equal(agent.plan?.path, ".agents/plans/plan-documentation-workflow.md");
  assert.match(await readFile(join(root, agent.plan!.path), "utf8"), /^# Workflow result: documentation\n/);
  await worq.cancel(agent.ref);
});

test("write workflow pins worq/<ref>, never merges, and runs no reviewers", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "change-log": workflowFile({ access: "write", description: "Change the log" }) });
  const { prompts } = userPrompts(agentDirPath);
  let system = "";
  let finish = "";
  const { worq, next, seen } = setup(root, state, {
    "agent.change-log": async (turn: Turn) => {
      system = turn.system;
      finish = turn.spec.tools.find((tool) => tool.name === "submit")!.description;
      await turn.tool("write_file", { path: "app.py", content: "print('CHANGED')\n" });
      await turn.tool("submit", { summary: "Changed the greeting", changes: ["app.py"] });
    },
  }, {}, undefined, prompts);
  const agent = await worq.runWorkflow(prompts.kinds.get("change-log")!);
  assert.equal(agent.ref, "change-log-workflow");
  assert.equal(agent.branch, "worq/change-log-workflow");
  const ready = await next("review-ready", agent.ref);
  assert.match(system, /No independent reviewers run for this workflow/);
  assert.match(finish, /^Submit your result\. Ends your turn\.$/);
  assert.ok(!seen.some((spec) => spec.name.startsWith("reviewer.")));
  assert.match(ready.text, new RegExp(`Branch worq/${agent.ref}`));
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('hello')\n", "no merge");
  assert.ok(existsSync(agent.work!));
  const work = agent.work!;
  await worq.cancel(agent.ref);
  assert.equal(agent.state, "closed");
  assert.ok(!existsSync(work), "worktree removed");
  git("rev-parse", "--verify", `worq/${agent.ref}`);
});

test("a review-ready workflow notice names cancel and its capacity slot, and the agent stays live", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { documentation: workflowFile({ access: "read", description: "Write docs" }) });
  const { prompts } = userPrompts(agentDirPath);
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => { await turn.tool("submit", planSubmission); },
  }, {}, undefined, prompts);
  const agent = await worq.runWorkflow(prompts.kinds.get("documentation")!);
  const ready = await next("review-ready", agent.ref);
  assert.match(ready.text, /review-ready/);
  assert.match(ready.text, new RegExp(`This workflow stays live until /worq cancel ${agent.ref}; it keeps one limits\\.agents slot\\.`));
  assert.ok(!agent.ended);
  assert.equal(worq.all().filter((candidate) => !candidate.ended).length, 1);
  assert.equal(worq.size, 1);
  await worq.cancel(agent.ref);
});

test("an invalid workflow file does not affect a successful plan spawn", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, {
    broken: workflowFile({ access: "read" }),
    documentation: workflowFile({ access: "read", description: "Write docs" }),
  });
  const { prompts, problems } = userPrompts(agentDirPath);
  assert.equal(problems.length, 1);
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => { await turn.tool("submit", planSubmission); },
    reviewer: async (turn) => { await turn.tool("report", pass); },
  }, {}, undefined, prompts);
  const plan = await worq.spawn("plan", "Plan the greeting", { title: "Plan the greeting" });
  await next("review-ready", plan.ref);
  assert.equal(plan.state, "review-ready");
  await worq.cancel(plan.ref);
  assert.equal(worq.list(plan.ref).includes("review-ready"), true);
});
