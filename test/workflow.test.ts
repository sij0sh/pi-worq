import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPrompts, loadWorkflows } from "../src/prompts.ts";
import { pass, planSubmission, repo, setup, type Turn } from "./fake.ts";

const section = (heading: string, title: string, text = "Do the work.") => `${heading} ${title}\n\n${text}\n`;

function workflowFile(options: { access?: string; description?: string; invocation?: string; reviewers?: string; body?: string } = {}) {
  const lines = ["---"];
  if (options.access !== undefined) lines.push(`access: ${options.access}`);
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  if (options.invocation !== undefined) lines.push(`invocation: ${options.invocation}`);
  if (options.reviewers !== undefined) lines.push(`reviewers: ${options.reviewers}`);
  lines.push("---", "");
  const body = options.body ?? `# Objective\n\nInspect the repository.\n\n${section("##", "Workflow")}\n${section("##", "Recursive question", "What remains unresolved?")}`;
  return `${lines.join("\n")}${body}`;
}

async function files(t: { after(callback: () => unknown): void }, entries: Record<string, string | "dir">) {
  const dir = await mkdtemp(join(tmpdir(), "worq-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(entries)) {
    if (value === "dir") await mkdir(join(dir, name));
    else await writeFile(join(dir, name), value);
  }
  return dir;
}

async function agentDir(t: { after(callback: () => unknown): void }, entries: Record<string, string | "dir">) {
  const dir = await mkdtemp(join(tmpdir(), "worq-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workflows = join(dir, "workflows");
  await mkdir(workflows);
  for (const [name, value] of Object.entries(entries)) {
    if (value === "dir") await mkdir(join(workflows, name));
    else await writeFile(join(workflows, name), value);
  }
  return dir;
}

/** Base prompts plus the user kinds the loader returns. */
function userPrompts(dir: string) {
  const prompts = loadPrompts();
  const loaded = loadWorkflows(join(dir, "workflows"), prompts);
  for (const [name, kind] of loaded.kinds) prompts.kinds.set(name, kind);
  return { prompts, ...loaded };
}

const docsExample = `---
access: read
description: Identify consequential architectural problems
---

# Objective

Identify structural problems that increase the cost or risk of changing the software.

## Workflow

1. Establish the project's architectural boundaries.
2. Inspect ownership, contracts and dependencies.
3. Identify violations with concrete evidence.
4. Recommend the smallest adequate corrections.

## Recursive question

What unresolved architectural concern could materially affect future changes?

## Completion

Submit prioritized findings, supporting evidence and recommended corrections.
`;

test("workflow loader: a missing directory is an empty installation", async () => {
  const { kinds, problems } = loadWorkflows("/nonexistent/worq/workflows", loadPrompts());
  assert.equal(kinds.size, 0);
  assert.deepEqual(problems, []);
});

test("workflow loader: H1 and H2 sections load as user kinds without reviewers", async (t) => {
  const dir = await files(t, {
    "audit-h1.md": workflowFile({ access: "read", description: "First", body: `# Workflow\n\nInspect.\n\n# Recursive question\n\nWhat is unresolved?\n` }),
    "audit-h2.md": workflowFile({ access: "write", description: "Second", body: `## Workflow\n\nChange.\n\n## Recursive question\n\nWhat is unresolved?\n` }),
  });
  const prompts = loadPrompts();
  const { kinds, problems } = loadWorkflows(dir, prompts);
  assert.deepEqual(problems, []);
  assert.deepEqual([...kinds.keys()].sort(), ["audit-h1", "audit-h2"]);
  const h1 = kinds.get("audit-h1")!;
  assert.equal(h1.access, "read");
  assert.equal(h1.description, "First");
  assert.equal(h1.invocation, "user");
  assert.equal(h1.reviewers, undefined);
  assert.match(h1.prompt, /# Workflow\n\nInspect\./);
  assert.equal(kinds.get("audit-h2")!.access, "write");
});

test("workflow loader: the documented example loads", async (t) => {
  const dir = await files(t, { "architecture-audit.md": docsExample });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts());
  assert.deepEqual(problems, []);
  assert.equal(kinds.get("architecture-audit")?.description, "Identify consequential architectural problems");
});

test("workflow loader: bad file names are problems and valid siblings still load", async (t) => {
  const dir = await files(t, {
    "audit-.md": workflowFile({ access: "read", description: "x" }),
    "audit--v2.md": workflowFile({ access: "read", description: "x" }),
    "Architecture Audit.md": workflowFile({ access: "read", description: "x" }),
    "audit.md": workflowFile({ access: "read", description: "Fine" }),
  });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts());
  assert.deepEqual([...kinds.keys()], ["audit"]);
  assert.equal(problems.length, 3);
  for (const problem of problems) assert.match(problem.message, /file name must be lowercase letters and digits/);
  assert.ok(problems.every((problem) => problem.path.startsWith(dir)));
});

test("workflow loader: unrelated entries are ignored", async (t) => {
  const dir = await files(t, {
    ".DS_Store": "junk",
    "notes.txt": "junk",
    "README.md": "junk",
    "readme.MD": "junk",
    "x.md": "dir",
  });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts());
  assert.equal(kinds.size, 0);
  assert.deepEqual(problems, []);
});

test("workflow loader: per-file defects are named and skipped", async (t) => {
  const dir = await files(t, {
    "plan.md": workflowFile({ access: "read", description: "Collides" }),
    "blank.md": "",
    "access.md": workflowFile({ description: "No access" }),
    "space.md": workflowFile({ access: " ", description: "Space access" }),
    "nodesc.md": workflowFile({ access: "read" }),
    "invoked.md": workflowFile({ access: "read", description: "Has invocation", invocation: "user" }),
    "fine.md": workflowFile({ access: "read", description: "Fine" }),
  });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts());
  assert.deepEqual([...kinds.keys()], ["fine"]);
  const messages = problems.map((problem) => problem.message);
  assert.ok(messages.some((message) => /"plan" is a built-in kind; rename the file/.test(message)));
  assert.ok(messages.some((message) => /blank\.md: is blank/.test(message)));
  assert.ok(messages.some((message) => /access\.md: access must be read or write/.test(message)));
  assert.ok(messages.some((message) => /space\.md: access must be read or write/.test(message)));
  assert.ok(messages.some((message) => /nodesc\.md: description is required \(shown by \/worq workflow\)/.test(message)));
  assert.ok(messages.some((message) => /invoked\.md: invocation is decided by the workflows directory; remove "invocation"/.test(message)));
});

test("workflow loader: required sections and reviewers are validated", async (t) => {
  const dir = await files(t, {
    "no-workflow.md": workflowFile({ access: "read", description: "x", body: `## Recursive question\n\nWhat?\n` }),
    "empty.md": workflowFile({ access: "read", description: "x", body: `## Workflow\n\n## Other\n\nText\n` }),
    "no-question.md": workflowFile({ access: "read", description: "x", body: `## Workflow\n\nDo it.\n` }),
    "none.md": workflowFile({ access: "read", description: "x", reviewers: "none" }),
    "plan-review.md": workflowFile({ access: "read", description: "x", reviewers: "plan" }),
    "nope.md": workflowFile({ access: "read", description: "x", reviewers: "nope" }),
  });
  const { kinds, problems } = loadWorkflows(dir, loadPrompts());
  assert.ok(problems.some((problem) => /no-workflow\.md: add a "Workflow" section/.test(problem.message)));
  assert.ok(problems.some((problem) => /empty\.md: add a "Workflow" section/.test(problem.message)));
  assert.ok(problems.some((problem) => /no-question\.md: add a "Recursive question" section/.test(problem.message)));
  assert.ok(problems.some((problem) => /nope\.md: reviewers "nope" is not a packaged roster \(plan, execute\)/.test(problem.message)));
  assert.equal(kinds.get("none")?.reviewers, undefined);
  assert.equal(kinds.get("plan-review")?.reviewers, "plan");
});

test("workflows cannot launch through worq_spawn, and shared kinds cannot launch as workflows", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "documentation.md": workflowFile({ access: "read", description: "Write docs" }) });
  const { prompts } = userPrompts(agentDirPath);
  const { worq } = setup(root, state, {}, {}, undefined, prompts);
  await assert.rejects(worq.spawn("documentation", "Write docs", { title: "Write docs" }), /is a user-invoked workflow; launch it with \/worq workflow/);
  await assert.rejects(worq.spawn("nope", "Write docs", { title: "Write docs" }), /Unknown kind nope[\s\S]*Workflows are launched with \/worq workflow/);
  await assert.rejects(worq.runWorkflow(prompts.kinds.get("plan")!, "Write docs"), /is a shared kind; launch it with worq_spawn/);
  assert.equal(worq.size, 0);
});

test("runWorkflow uses the workflow ref and either the written task or the user's direction", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "documentation.md": workflowFile({ access: "read", description: "Write docs" }) });
  const { prompts } = userPrompts(agentDirPath);
  const tasks: string[] = [];
  const { worq, next } = setup(root, state, {
    "agent.documentation": async (turn) => {
      tasks.push(JSON.parse(turn.text).task);
      await turn.tool("submit", planSubmission);
    },
  }, {}, undefined, prompts);
  const kind = prompts.kinds.get("documentation")!;
  const agent = await worq.runWorkflow(kind);
  assert.equal(agent.ref, "documentation-workflow");
  assert.equal(agent.title, "documentation");
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
  const agentDirPath = await agentDir(t, { "documentation.md": workflowFile({ access: "read", description: "Write docs" }) });
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

test("read workflow without a roster: Workflow result artifact, no reviewers, no-reviewer notes", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "documentation.md": workflowFile({ access: "read", description: "Write docs" }) });
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
  assert.ok(!seen.some((spec) => spec.profile === "reviewer"));
  assert.deepEqual(agent.reviews, []);
  assert.equal(agent.reviewPolicyLabel, "no configured reviewers");
  assert.match(ready.text, /No reviewers ran: this result is unverified\./);
  assert.equal(agent.plan?.path, ".agents/plans/plan-documentation-workflow.md");
  assert.match(await readFile(join(root, agent.plan!.path), "utf8"), /^# Workflow result: documentation\n/);
  await worq.cancel(agent.ref);
});

test("read workflow with reviewers: the selected roster runs and is named in the policy", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "reviewed.md": workflowFile({ access: "read", description: "Reviewed docs", reviewers: "plan" }) });
  const { prompts } = userPrompts(agentDirPath);
  let finish = "";
  const reviewers: string[] = [];
  const { worq, next } = setup(root, state, {
    "agent.reviewed": async (turn) => {
      finish = turn.spec.tools.find((tool) => tool.name === "submit")!.description;
      await turn.tool("submit", planSubmission);
    },
    reviewer: async (turn) => { reviewers.push(turn.spec.name); await turn.tool("report", pass); },
  }, {}, undefined, prompts);
  const agent = await worq.runWorkflow(prompts.kinds.get("reviewed")!);
  const ready = await next("review-ready", agent.ref);
  assert.match(finish, /^Submit your result for independent review\. Worq saves it to \.agents\/plans\/\./);
  assert.deepEqual(reviewers.sort(), ["reviewer.decision", "reviewer.defeater", "reviewer.pair", "reviewer.subtraction"]);
  assert.equal(agent.reviewPolicyLabel, "roster plan");
  assert.match(worq.list(agent.ref), /review: roster plan/);
  assert.match(ready.text, /decision: pass/);
  await worq.cancel(agent.ref);
});

test("write workflow pins worq/<ref>, never merges, and runs no reviewers by default", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDirPath = await agentDir(t, { "change-log.md": workflowFile({ access: "write", description: "Change the log" }) });
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
  assert.match(finish, /^Submit your work\. Ends your turn\.$/);
  assert.ok(!seen.some((spec) => spec.profile === "reviewer"));
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
  const agentDirPath = await agentDir(t, { "documentation.md": workflowFile({ access: "read", description: "Write docs" }) });
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
    "broken.md": workflowFile({ access: "read", description: "Broken", body: `## Workflow\n\nNo question.\n` }),
    "documentation.md": workflowFile({ access: "read", description: "Write docs" }),
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
