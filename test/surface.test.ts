import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Type } from "typebox";
import { createWorq, TOOLS } from "../index.ts";
import { DEFAULT_LIMITS, loadConfig } from "../src/runtime/config.ts";
import { dispatch, ops, serve } from "../src/control.ts";
import { obj, text } from "../src/contracts.ts";
import { loadPrompts } from "../src/prompts.ts";
import { Conversation, NUDGE } from "../src/session.ts";
import { fakeDriver, pass, planSubmission, repo, setup, type Script } from "./fake.ts";

const never = new AbortController().signal;
const finish = { name: "done", description: "Finish.", schema: obj({ value: text(20) }) };
const conversation = (script: Parameters<typeof fakeDriver>[0][string], pending?: () => number) => new Conversation({
  driver: fakeDriver({ x: script }), signal: never, turns: 10, minutes: 1, finish, pending,
  spec: { name: "x", cwd: "/", system: "", tools: [], log() {} },
});

test("conversation: one settlement nudge, rejected finish is explained, then fails", async () => {
  const texts: string[] = [];
  const ok = conversation(async (turn) => { texts.push(turn.text); if (turn.text === NUDGE) await turn.tool("done", { value: "v" }); });
  assert.deepEqual(await ok.run("go"), { value: "v" });
  assert.deepEqual(texts, ["go", NUDGE]);

  const seen: string[] = [];
  const bad = conversation(async (turn) => { seen.push(turn.text); await turn.tool("done", { value: "" }); });
  await assert.rejects(bad.run("go"), /submission rejected: Invalid done arguments/);
  assert.match(seen[1], /Your done call was rejected/);
});

test("conversation: waits for pending work and takes delivered messages in order", async () => {
  let open = 1;
  const texts: string[] = [];
  const c = conversation(async (turn) => { texts.push(turn.text); if (turn.text === "answer") await turn.tool("done", { value: "ok" }); }, () => open);
  const result = c.run("start");
  await new Promise((r) => setTimeout(r, 20));
  open = 0;
  c.deliver("answer");
  assert.deepEqual(await result, { value: "ok" });
  assert.deepEqual(texts, ["start", "answer"]);
});

test("conversation: turn limit aborts", async () => {
  const c = new Conversation({ driver: fakeDriver({ x: () => {} }), signal: never, turns: 1, minutes: 1, finish,
    spec: { name: "x", cwd: "/", system: "", tools: [], log() {} } });
  await assert.rejects(c.run("go"), /turn limit/);
});

test("config: defaults, model lookup by specificity, invalid keys name the file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadConfig(dir).limits, DEFAULT_LIMITS);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ default: "a", runtimes: { a: { model: "a/m" }, b: { model: "b/r" }, c: { model: "c/i" } }, roles: { reviewer: "b", "reviewer.intent": "c" }, limits: { rounds: 5 } }));
  const config = loadConfig(dir);
  assert.equal(config.limits.rounds, 5);
  assert.equal(config.limits.agents, DEFAULT_LIMITS.agents);
  assert.equal(config.runtime("agent.plan").model, "a/m");
  assert.equal(config.runtime("reviewer.pair").model, "b/r");
  assert.equal(config.runtime("reviewer.intent").model, "c/i");
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ limits: { rounds: 0 } }));
  assert.throws(() => loadConfig(dir), /pi-worq\.json: \/limits\/rounds/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ agents: { plan: {} }, scq: {} }));
  assert.throws(() => loadConfig(dir), /agents, scq are from the old Worq format/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ land: "auto" }));
  assert.throws(() => loadConfig(dir), /pi-worq\.json/);
});

test("prompts: kinds and reviewer rosters are data", () => {
  const prompts = loadPrompts();
  assert.deepEqual([...prompts.kinds.keys()].sort(), ["execute", "plan"]);
  assert.equal(prompts.kinds.get("plan")!.access, "read");
  assert.equal(prompts.kinds.get("execute")!.access, "write");
  assert.ok([...prompts.kinds.values()].every((kind) => !kind.workflow));
  assert.deepEqual(prompts.reviewers("plan").map((r) => r.name), ["decision", "defeater", "pair", "subtraction"]);
  assert.deepEqual(prompts.reviewers("execute").map((r) => r.name), ["intent"]);
});

test("tools are hidden until /worq, restored on resume, and share one schema with the CLI", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(agentDir);
  await writeFile(join(agentDir, "pi-worq.json"), JSON.stringify({ limits: { agentTurns: 2, reviewerTurns: 2, runTurns: 5 } }));
  process.env.WORQ_STATE_DIR = state;
  const tools: { name: string; defaultActive?: boolean; parameters: unknown; execute: Function }[] = [];
  const handlers: Record<string, Function> = {};
  let command: Function | undefined;
  let inspect: Function | undefined;
  let renderNotice: Function | undefined;
  let active = ["read", "bash"];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const notices: { message: { content: string; customType: string; details: { ref: string; type?: string } }; options: { triggerTurn: boolean; deliverAs?: string } }[] = [];
  const alerts: string[] = [];
  const requests: string[] = [];
  const pi = {
    sendUserMessage: (text: string) => requests.push(text),
    registerTool: (tool: never) => tools.push(tool),
    registerCommand: (name: string, options: { handler: Function }) => { if (name === 'worq') command = options.handler; else if (name === 'worq-inspect') inspect = options.handler; },
    registerMessageRenderer(_name: string, renderer: Function) { renderNotice = renderer; },
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: typeof notices[number]["message"], options: typeof notices[number]["options"]) => notices.push({ message, options }),
  };
  const fastReviews: string[] = [];
  const scripts: Record<string, Script> = {
    "agent.plan": async turn => {
      if (turn.text.startsWith("Main reviewed round 1")) {
        assert.match(turn.text, /Remove the watcher/);
        await turn.tool("submit", { ...planSubmission, summary: "Use one direct report, no background process." });
        return;
      }
      if (!turn.text.startsWith("{") || JSON.parse(turn.text).task === "Hand it off") return;
      if (JSON.parse(turn.text).task === "Fail it") throw new Error("Fixture failure");
      if (JSON.parse(turn.text).task === "Plan it") {
        assert.match(await turn.tool("ask_main", { question: "Which greeting?" }), /Use HELLO/);
      }
      await turn.tool("submit", planSubmission);
    },
    "agent.execute": async turn => { await turn.tool("submit", { summary: "No changes" }); },
    reviewer: async turn => {
      if (JSON.parse(turn.text).request === "Simplify the report") {
        assert.match(turn.system, /flag missing required outcomes as well as unnecessary scope/);
        fastReviews.push(turn.spec.name);
      }
      await turn.tool("report", pass);
    },
  };
  createWorq({ driver: () => fakeDriver(scripts), agentDir: () => agentDir })(pi as never);
  assert.deepEqual(tools.map((x) => x.name), [...TOOLS]);
  assert.ok(tools.every((x) => x.defaultActive === false));
  assert.ok(!active.some((name) => name.startsWith("worq_")));
  let widget: { render(width: number): string[] } | undefined;
  const ctx = { mode: "tui", cwd: root, ui: { notify(text: string) { alerts.push(text); }, setStatus() {},
    setWidget(key: string, factory?: Function) {
      assert.equal(key, "worq");
      widget = factory?.({ requestRender() {} }, { fg: (_: string, value: string) => value });
    },
  }, sessionManager: { getBranch: () => entries } };
  await command!("", ctx);
  assert.ok(TOOLS.every((name) => active.includes(name)));
  await command!("off", ctx);
  assert.ok(!active.some((name) => name.startsWith("worq_")));
  const inspectorCtx = { ...ctx, ui: { ...ctx.ui, custom: async (create: Function) => {
    let closed = false;
    const panel = create({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_: string, s: string) => s }, {}, () => { closed = true; });
    assert.match(panel.render(100).join(' '), /Worq/);
    panel.handleInput('\x1b');
    assert.equal(closed, false);
    panel.handleInput('\x1b');
    assert.ok(closed);
  } } };
  const entryCount = entries.length;
  await inspect!('', inspectorCtx);
  await inspect!('aaaa extra', inspectorCtx);
  assert.equal(entries.length, entryCount);
  assert.ok(!active.some((name) => name.startsWith('worq_')));
  await command!("inspect", ctx);
  await command!("inspect the failing tests", ctx);
  await command!("describe the greeting", ctx);
  assert.deepEqual(requests, ["inspect", "inspect the failing tests", "describe the greeting"]);
  assert.equal(notices.length, 0);
  active = ["read"];
  await handlers.session_start({}, ctx);
  assert.ok(TOOLS.every((name) => active.includes(name)), "resume restores /worq");

  const spawn = tools.find((x) => x.name === "worq_spawn")!;
  const result = await spawn.execute("id", { kind: "plan", title: "Surface test", task: "Plan it" }, undefined, undefined, ctx);
  const ref = result.details.ref;
  assert.equal(ref, "surface-test");
  assert.deepEqual(result.details, { ref });
  // The CLI reaches the same operations through the control socket.
  const run = promisify(execFile);
  const cli = join(import.meta.dirname, "..", "bin", "worq.mjs");
  const env = { ...process.env, WORQ_STATE_DIR: state };
  const waitFor = async (type: string) => {
    const find = () => notices.find(({ message }) => message.details.type === type && message.details.ref === ref);
    for (let i = 0; i < 100 && !find(); i++) await new Promise((r) => setTimeout(r, 25));
    const notice = find();
    assert.ok(notice, `expected a ${type} notice`);
    return notice;
  };
  const asked = await waitFor("ask");
  assert.match(asked.message.content, /^Surface test \(surface-test\) · plan asks:/);
  assert.deepEqual(asked.options, { triggerTurn: true, deliverAs: "followUp" });
  const theme = { fg: (_: string, text: string) => text };
  const durable = { ...asked.message, content: `[worq ${ref}] Legacy heading\nPrintable legacy-only detail` };
  assert.doesNotMatch(renderNotice!(durable, { expanded: false }, theme).render(120).join(" "), /legacy-only/);
  assert.match(renderNotice!(durable, { expanded: true }, theme).render(120).join(" "), /Printable legacy-only detail/);
  await command!("off", ctx);
  assert.ok(active.includes("worq_send") && !active.includes("worq_spawn"));
  await assert.rejects(spawn.execute("id", { kind: "plan", title: "Surface test", task: "blocked" }, undefined, undefined, ctx), /off/);
  await command!(`send ${ref} Use HELLO`, ctx);
  const ready = await waitFor("review-ready");
  await inspect!(ref, inspectorCtx);
  assert.deepEqual(ready.options, { triggerTurn: true, deliverAs: "followUp" });
  const warnings = notices.filter(({ message }) => message.details.ref === ref && message.details.type === "warning");
  assert.ok(warnings.some(({ message }) => /one further turn remains/.test(message.content)));
  assert.ok(warnings.some(({ message }) => /no additional turns can be granted/.test(message.content)));
  assert.ok(warnings.every(({ options }) => !options.triggerTurn && options.deliverAs === undefined));
  assert.ok(!notices.some(({ message }) => message.details.ref === ref && message.details.type === "checkpoint"));
  const assistant = { role: "assistant" };
  const ask = { ...asked.message, role: "custom" };
  const grant = { role: "custom", customType: "worq", details: { type: "checkpoint" } };
  const passive = warnings.map(({ message }) => ({ ...message, role: "custom" }));
  assert.deepEqual(handlers.context({ messages: [assistant, ...passive, ask, grant] }).messages, [assistant, ask, grant]);
  assert.equal(handlers.context({ messages: [assistant, ask, grant] }), undefined);
  assert.match((await run(process.execPath, [cli, "list", ref], { env })).stdout, /Plan: \.agents\/plans\//);
  assert.match((await run(process.execPath, [cli, "cancel", ref], { env })).stdout, /already review-ready/);
  assert.ok(!active.some(name => name.startsWith("worq_")));
  await command!("", ctx);
  assert.ok(active.includes("worq_spawn"));
  const fastRef = "surface-test-2";
  const launched = await run(process.execPath, [cli, "spawn", "plan", "--title", "Surface test", "--attach", ref, "--mode", "fast", "--attach", `.agents/plans/plan-${ref}.md`, "Simplify the report"], { env });
  assert.match(launched.stdout, /Surface test \(surface-test-2\).*plan-surface-test\.md/);
  const waitForRound = async (round: number) => {
    const ready = () => notices.some(({ message }) => message.details.ref === fastRef && message.details.type === "review-ready" && message.content.includes(`round ${round} review-ready`));
    for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(ready(), `expected fast plan round ${round}`);
  };
  await waitForRound(1);
  assert.match((await run(process.execPath, [cli, "list", fastRef], { env })).stdout, /review: focused \(subtraction\)/);
  await command!(`send ${fastRef} Remove the watcher`, ctx);
  assert.deepEqual(fastReviews, ["reviewer.subtraction"]);
  assert.match((await run(process.execPath, [cli, "list", fastRef], { env })).stdout, /review-ready · round 1/);
  assert.doesNotMatch((await run(process.execPath, [cli, "list"], { env })).stdout, / · execute · /);
  await command!(`cancel ${fastRef}`, ctx);
  const failedRun = await spawn.execute("id", { kind: "plan", title: "Surface test", task: "Fail it" }, undefined, undefined, ctx);
  for (let i = 0; i < 100 && !notices.some(n => n.message.details.type === "failed"); i++) await new Promise(r => setTimeout(r, 15));
  assert.ok(notices.some(n => n.message.details.type === "failed" && n.message.details.ref === failedRun.details.ref));
  assert.match(widget?.render(34).join("\n") ?? "", /Surface test failed Main/);
  assert.match(widget?.render(20)[0] ?? "", /0 live/);
  const handed = await spawn.execute("id", { kind: "plan", title: "Hand off surface", task: "Hand it off" }, undefined, undefined, ctx);
  const handoffNotices = () => notices.filter(n => n.message.details.type === "handed-off" && n.message.details.ref === handed.details.ref);
  for (let i = 0; i < 100 && !handoffNotices().length; i++) await new Promise(r => setTimeout(r, 15));
  assert.equal(handoffNotices().length, 1);
  assert.deepEqual(handoffNotices()[0].options, { triggerTurn: false });
  assert.match((await run(process.execPath, [cli, "list", handed.details.ref], { env })).stdout, /handed-off[\s\S]*Unreviewed handoff:/);
  await handlers.session_shutdown({}, ctx);
  assert.equal(widget, undefined);
  delete process.env.WORQ_STATE_DIR;
});

test("the /worq workflow launcher selects a workflow, takes optional instructions and never enables worq_spawn", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = await mkdtemp(join(tmpdir(), "worq-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  // Workflows are read once at extension load; installed before it.
  const install = async (name: string, text: string) => { await mkdir(join(agentDir, "workflows", name), { recursive: true }); await writeFile(join(agentDir, "workflows", name, "SKILL.md"), text); };
  await install("docs", "---\nname: docs\ndescription: Write the docs\naccess: read\ndisable-model-invocation: true\n---\n\nWrite it.\n");
  await install("shared", "---\ndescription: Shared docs\naccess: read\n---\n\nWrite it.\n");
  await install("broken", "---\naccess: read\n---\n\nNo description.\n");
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.WORQ_STATE_DIR = state;
  t.after(() => { delete process.env.WORQ_STATE_DIR; });

  const tools: { name: string; description: string; parameters: { properties?: Record<string, unknown> }; execute: Function }[] = [];
  let command: Function | undefined;
  let active = ["read"];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const notices: { content: string; type?: string; ref: string }[] = [];
  const alerts: { text: string; level: string }[] = [];
  const tasks: string[] = [];
  const selects: string[][] = [];
  const inputs: { title: string; placeholder?: string }[] = [];
  let choose: "first" | "cancel" = "first";
  let answer: string | undefined = "";
  const pi = {
    sendUserMessage: () => {},
    registerTool: (tool: never) => tools.push(tool),
    registerCommand: (name: string, options: { handler: Function }) => { if (name === "worq") command = options.handler; },
    registerMessageRenderer() {},
    on() {},
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: { content: string; details: { ref: string; type?: string } }) => notices.push({ content: message.content, type: message.details.type, ref: message.details.ref }),
  };
  createWorq({
    agentDir: () => agentDir,
    driver: () => fakeDriver({ "agent.docs": async (turn) => { tasks.push(JSON.parse(turn.text).task); await turn.tool("submit", planSubmission); } }),
  })(pi as never);
  const ctx = {
    mode: "tui", cwd: root,
    ui: {
      notify: (text: string, level: string) => alerts.push({ text, level }),
      setStatus() {},
      setWidget() {},
      select: async (_title: string, options: string[]) => { selects.push(options); return choose === "first" ? options[0] : undefined; },
      input: async (title: string, placeholder?: string) => { inputs.push({ title, placeholder }); return answer; },
    },
    sessionManager: { getBranch: () => entries },
  };
  const last = (pattern: RegExp) => alerts.map((alert) => alert.text).filter((text) => pattern.test(text)).at(-1);
  const launchedRef = () => /as ([a-z0-9-]+)\./.exec(last(/^Launched workflow /) ?? "")?.[1];
  const settle = async (ref: string) => {
    for (let i = 0; i < 100 && !notices.some((notice) => notice.ref === ref && notice.type === "review-ready"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(notices.some((notice) => notice.ref === ref && notice.type === "review-ready"), `expected review-ready for ${ref}`);
  };

  // Every workflow is in the menu (user-only marked); invalid siblings are reported.
  await command!("workflow", ctx);
  assert.match(last(/broken: description is required/) ?? "", /broken/);
  assert.deepEqual(selects.at(-1), ["docs · read · user-only · Write the docs", "shared · read · Shared docs"]);
  assert.equal(launchedRef(), "docs-workflow");
  await settle("docs-workflow");
  const workflowTools = tools.map((tool) => tool.name);
  assert.deepEqual(workflowTools, [...TOOLS]);
  assert.ok(active.includes("worq_list") && active.includes("worq_send") && active.includes("worq_cancel"));
  assert.ok(!active.includes("worq_spawn"));
  assert.ok(!entries.some((entry) => entry.customType === "worq-enabled"), "a workflow launch does not enable Main's spawn");
  const spawn = tools.find((tool) => tool.name === "worq_spawn")!;
  assert.deepEqual((spawn.parameters as unknown as { properties: { kind: { enum: string[] } } }).properties.kind.enum, ["execute", "plan", "shared"]);
  assert.match(spawn.description, /shared: Shared docs/);
  assert.doesNotMatch(spawn.description, /Write the docs/, "user-only workflows are not offered to the model");
  assert.ok(!("workflow" in ops(["plan", "execute"])), "workflows are not a control op");
  await assert.rejects(spawn.execute("id", { kind: "docs", title: "Docs", task: "x" }, undefined, undefined, ctx), /kind/);
  await command!("cancel docs-workflow", ctx);

  // Empty instructions launch the workflow as written; non-empty instructions become the task.
  assert.equal(tasks.at(-1), "Run the docs workflow on this repository and submit its result.");
  assert.equal(inputs.at(-1)?.title, "Additional instructions for docs (optional)");
  assert.equal(inputs.at(-1)?.placeholder, "Leave empty to run the workflow as written");
  answer = "Focus on the CLI reference";
  await command!("workflow", ctx);
  assert.equal(launchedRef(), "docs-workflow-2");
  await settle("docs-workflow-2");
  assert.equal(tasks.at(-1), "Focus on the CLI reference");
  await command!("cancel docs-workflow-2", ctx);

  // Escape at the instructions step or the menu cancels without launching.
  const launches = () => alerts.filter((alert) => /^Launched workflow /.test(alert.text)).length;
  const before = launches();
  answer = undefined;
  await command!("workflow", ctx);
  assert.equal(launches(), before);
  answer = "";
  choose = "cancel";
  await command!("workflow", ctx);
  assert.equal(launches(), before);
  choose = "first";

  // `workflow` is a reserved first word with no arguments.
  await command!("workflow extra", ctx);
  assert.equal(last(/^Usage: \/worq workflow$/), "Usage: /worq workflow");
  assert.equal(launches(), before);

  // Non-TUI sessions are told the launcher needs a TUI.
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as never;
  try { await command!("workflow", { ...ctx, mode: "rpc" }); }
  finally { process.stderr.write = write; }
  assert.match(stderr, /Workflow launcher requires a TUI\./);

  // /worq off still blocks Main's worq_spawn, but an explicit user workflow launch is honored.
  await command!("off", ctx);
  assert.ok(!active.includes("worq_spawn"));
  answer = "";
  await command!("workflow", ctx);
  assert.equal(launchedRef(), "docs-workflow-3");
  await settle("docs-workflow-3");
  assert.ok(!active.includes("worq_spawn"));
  await assert.rejects(spawn.execute("id", { kind: "plan", title: "Surface test", task: "blocked" }, undefined, undefined, ctx), /off/);
  await command!("list", ctx);
  assert.match(alerts.at(-1)!.text, /docs-workflow-3/);
  await command!("cancel docs-workflow-3", ctx);
});

test("dispatch validates arguments against the shared schema", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq } = setup(root, state, {});
  const table = ops(["plan", "execute"]);
  assert.deepEqual(Object.keys(table.spawn.properties).sort(), ["attach", "kind", "mode", "reason", "task", "title", "verify"]);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "review", title: "Surface test", task: "x" }), /kind/);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "plan", title: "Surface test", task: "x", verify: "no" }), /verify/);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "plan", title: "Surface test", task: "x", verify: false }), /verify:false applies to execute only/);
  assert.equal(worq.size, 0, "a refused spawn leaves no agent");
  await assert.rejects(dispatch(worq, table, "send", { ref: "zz", text: "x" }), /ref/);
  await assert.rejects(dispatch(worq, table, "nope", {}), /Unknown operation/);
  assert.match((await dispatch(worq, table, "list", {})).text, /No Worq agents/);
  const socket = await serve(state, (op, args) => dispatch(worq, table, op, args));
  await socket.close();
  assert.ok(Type.Object({}));
});
