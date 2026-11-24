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
import { fakeDriver, KINDS, pass, planSubmission, repo, setup, type Script } from "./fake.ts";

const never = new AbortController().signal;
const finish = { description: "Finish.", schema: obj({ value: text(20) }) };
const conversation = (script: Parameters<typeof fakeDriver>[0][string], pending?: () => number) => new Conversation({
  driver: fakeDriver({ x: script }), signal: never, turns: 10, minutes: 1, finish, pending,
  spec: { name: "x", cwd: "/", system: "", tools: [], log() {} },
});

test("conversation: one settlement nudge, rejected finish is explained, then fails", async () => {
  const texts: string[] = [];
  const ok = conversation(async (turn) => { texts.push(turn.text); if (turn.text === NUDGE) await turn.tool("submit", { value: "v" }); });
  assert.deepEqual(await ok.run("go"), { value: "v" });
  assert.deepEqual(texts, ["go", NUDGE]);

  const seen: string[] = [];
  const bad = conversation(async (turn) => { seen.push(turn.text); await turn.tool("submit", { value: "" }); });
  await assert.rejects(bad.run("go"), /submission rejected: Invalid submit arguments/);
  assert.match(seen[1], /Your submit call was rejected/);
});

test("conversation: waits for pending work and takes delivered messages in order", async () => {
  let open = 1;
  const texts: string[] = [];
  const c = conversation(async (turn) => { texts.push(turn.text); if (turn.text === "answer") await turn.tool("submit", { value: "ok" }); }, () => open);
  const result = c.run("start");
  await new Promise((r) => setTimeout(r, 20));
  open = 0;
  c.deliver("answer");
  assert.deepEqual(await result, { value: "ok" });
  assert.deepEqual(texts, ["start", "answer"]);
});

test("conversation: turn limit aborts one invocation; the next gets a fresh budget and tools are fenced between runs", async () => {
  let late: (() => Promise<string>) | undefined;
  const c = new Conversation({ driver: fakeDriver({ x: async (turn) => {
    late ??= () => turn.tool("submit", { value: "late" });
    if (turn.text === "again") await turn.tool("submit", { value: "ok" });
  } }), signal: never, turns: 1, minutes: 1, finish,
    spec: { name: "x", cwd: "/", system: "", tools: [], log() {} } });
  await assert.rejects(c.run("go"), /turn limit/);
  assert.match(await late!(), /Tool dispatch is closed/);
  assert.deepEqual(await c.run("again"), { value: "ok" });
});

test("config: defaults, removed keys become migration findings, invalid keys name the file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadConfig(dir).limits, DEFAULT_LIMITS);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ plan: { model: "a/m" }, review: { model: "b/r" }, limits: { idleMinutes: 5 } }));
  const config = loadConfig(dir);
  assert.equal(config.limits.idleMinutes, 5);
  assert.equal(config.limits.agents, DEFAULT_LIMITS.agents);
  assert.match(config.migration ?? "", /pi-worq\.json: \/plan, \/review are no longer supported/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ limits: { idleMinutes: 0 } }));
  assert.throws(() => loadConfig(dir), /pi-worq\.json: \/limits\/idleMinutes/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ agents: { plan: {} }, scq: {} }));
  assert.match(loadConfig(dir).migration ?? "", /\/agents, \/scq are no longer supported/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ land: "auto" }));
  assert.throws(() => loadConfig(dir), /pi-worq\.json/);
});

test("shipped Plan and Execute are ordinary packages; one review prompt", () => {
  assert.deepEqual([...KINDS.keys()].sort(), ["execute", "plan"]);
  assert.equal(KINDS.get("plan")!.access, "read");
  assert.equal(KINDS.get("execute")!.access, "write");
  assert.ok([...KINDS.values()].every((kind) => kind.review && !kind.userOnly && kind.skill));
  assert.match(loadPrompts().review, /What consequential reason is there not to accept this result as-is\?/);
});

test("tools are hidden until /worq, restored on resume, and share one schema with the CLI", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(agentDir);
  await writeFile(join(agentDir, "pi-worq.json"), JSON.stringify({ limits: { agentTurns: 2, reviewerTurns: 2 } }));
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
  const resumedReviews: string[] = [];
  const scripts: Record<string, Script> = {
    "agent.plan": async turn => {
      if (turn.text === "Main: Remove the watcher") {
        await turn.tool("submit", { ...planSubmission, summary: "Use one direct report, no background process." });
        return;
      }
      if (!turn.text.startsWith("{")) return;
      if (JSON.parse(turn.text).task === "Hand it off") { turn.steered.push("more"); return; }
      if (JSON.parse(turn.text).task === "Fail it") throw new Error("Fixture failure");
      if (JSON.parse(turn.text).task === "Plan it") {
        assert.match(await turn.tool("ask_main", { question: "Which greeting?" }), /Use HELLO/);
      }
      await turn.tool("submit", planSubmission);
    },
    "agent.execute": async turn => { await turn.tool("submit", { summary: "No changes" }); },
    review: async turn => {
      const payload = JSON.parse(turn.text);
      if (payload.request === "Simplify the report") resumedReviews.push(payload.submission);
      await turn.tool("submit", pass);
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
  await command!("on", ctx);
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
  const ready = await waitFor("parked");
  await inspect!(ref, inspectorCtx);
  assert.deepEqual(ready.options, { triggerTurn: true, deliverAs: "followUp" });
  const warnings = notices.filter(({ message }) => message.details.ref === ref && message.details.type === "warning");
  assert.ok(warnings.some(({ message }) => /one further turn remains/.test(message.content)));
  assert.ok(warnings.every(({ options }) => !options.triggerTurn && options.deliverAs === undefined));
  const assistant = { role: "assistant" };
  const ask = { ...asked.message, role: "custom" };
  const parked = { ...ready.message, role: "custom" };
  const passive = warnings.map(({ message }) => ({ ...message, role: "custom" }));
  assert.deepEqual(handlers.context({ messages: [assistant, ...passive, ask, parked] }).messages, [assistant, ask, parked]);
  assert.equal(handlers.context({ messages: [assistant, ask, parked] }), undefined);
  assert.match((await run(process.execPath, [cli, "list", ref], { env })).stdout, /Plan: \.agents\/plans\//);
  assert.match((await run(process.execPath, [cli, "cancel", ref], { env })).stdout, /surface-test closed/);
  assert.ok(!active.some(name => name.startsWith("worq_")));
  await command!("on", ctx);
  assert.ok(active.includes("worq_spawn"));
  const nextRef = "surface-test-2";
  const launched = await run(process.execPath, [cli, "spawn", "plan", "--title", "Surface test", "--attach", ref, "--attach", `.agents/plans/plan-${ref}.md`, "Simplify the report"], { env });
  assert.match(launched.stdout, /Surface test \(surface-test-2\).*plan-surface-test\.md/);
  const waitForRound = async (round: number) => {
    const ready = () => notices.some(({ message }) => message.details.ref === nextRef && message.details.type === "parked" && message.content.includes(`round ${round} parked`));
    for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(ready(), `expected plan round ${round}`);
  };
  await waitForRound(1);
  await command!(`send ${nextRef} Remove the watcher`, ctx);
  await waitForRound(2);
  assert.equal(resumedReviews.length, 2, "each submission gets one review");
  assert.match(resumedReviews[1], /no background process/);
  assert.match((await run(process.execPath, [cli, "list", nextRef], { env })).stdout, /parked · round 2/);
  assert.doesNotMatch((await run(process.execPath, [cli, "list"], { env })).stdout, / · execute · /);
  await command!(`cancel ${nextRef}`, ctx);
  const failedRun = await spawn.execute("id", { kind: "plan", title: "Surface test", task: "Fail it" }, undefined, undefined, ctx);
  for (let i = 0; i < 100 && !notices.some(n => n.message.details.type === "failed"); i++) await new Promise(r => setTimeout(r, 15));
  assert.ok(notices.some(n => n.message.details.type === "failed" && n.message.details.ref === failedRun.details.ref));
  assert.match(widget?.render(34).join("\n") ?? "", /Surface test failed Main/);
  assert.match(widget?.render(20)[0] ?? "", /0 live/);
  const spent = await spawn.execute("id", { kind: "plan", title: "Exhaust surface", task: "Hand it off" }, undefined, undefined, ctx);
  const spentNotices = () => notices.filter(n => n.message.details.type === "parked" && n.message.details.ref === spent.details.ref);
  for (let i = 0; i < 100 && !spentNotices().length; i++) await new Promise(r => setTimeout(r, 15));
  assert.equal(spentNotices().length, 1);
  assert.deepEqual(spentNotices()[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match((await run(process.execPath, [cli, "list", spent.details.ref], { env })).stdout, /parked[\s\S]*Parked without submission: .*turn limit/);
  await handlers.session_shutdown({}, ctx);
  assert.equal(widget, undefined);
  delete process.env.WORQ_STATE_DIR;
});

test("/worq launches any package: select → optional instructions → explicit runtime; tools activate only on admission", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = await mkdtemp(join(tmpdir(), "worq-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  // The catalog is read once at extension load; installed before it.
  const install = async (name: string, text: string) => { await mkdir(join(agentDir, "workflows", name), { recursive: true }); await writeFile(join(agentDir, "workflows", name, "SKILL.md"), text); };
  await install("docs", "---\nname: docs\ndescription: Write the docs\naccess: read\ndisable-model-invocation: true\n---\n\nWrite it.\n");
  await install("shared", "---\ndescription: Shared docs\naccess: read\n---\n\nWrite it.\n");
  await install("broken", "---\naccess: read\n---\n\nNo description.\n");
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.WORQ_STATE_DIR = state;
  t.after(() => { delete process.env.WORQ_STATE_DIR; });

  const tools: { name: string; description: string; parameters: { properties?: Record<string, { enum?: unknown; pattern?: string }> }; execute: Function }[] = [];
  let command: Function | undefined;
  let active = ["read"];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const notices: { content: string; type?: string; ref: string }[] = [];
  const alerts: { text: string; level: string }[] = [];
  const tasks: string[] = [];
  const selects: string[][] = [];
  const inputs: { title: string; placeholder?: string }[] = [];
  const overlays: string[] = [];
  let choose: string | undefined = "docs";
  let answer: string | undefined = "";
  /** Keys pressed in successive overlays (runtime step, then the off confirmation). */
  let keys: string[] = [];
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
  const record = async (turn: { text: string; tool(name: string, params: object): Promise<string> }) => { tasks.push(JSON.parse(turn.text).task); await turn.tool("submit", planSubmission); };
  createWorq({ agentDir: () => agentDir, driver: () => fakeDriver({ "agent.docs": record, "agent.shared": record }) })(pi as never);
  const ctx = {
    mode: "tui", cwd: root,
    ui: {
      notify: (text: string, level: string) => alerts.push({ text, level }),
      setStatus() {},
      setWidget() {},
      select: async (_title: string, options: string[]) => { selects.push(options); return choose === undefined ? undefined : options.find((o) => o.startsWith(`${choose} ·`)); },
      input: async (title: string, placeholder?: string) => { inputs.push({ title, placeholder }); return answer; },
      custom: (factory: Function) => new Promise((resolve) => {
        const component = factory({ requestRender() {}, terminal: { rows: 30 } }, { fg: (_: string, s: string) => s }, {}, resolve);
        overlays.push(component.render(100).join("\n"));
        component.handleInput(keys.shift() ?? "\r");
      }),
    },
    sessionManager: { getBranch: () => entries },
  };
  const last = (pattern: RegExp) => alerts.map((alert) => alert.text).filter((text) => pattern.test(text)).at(-1);
  const launchedRef = () => /as ([a-z0-9-]+)\./.exec(last(/^Launched /) ?? "")?.[1];
  const launches = () => alerts.filter((alert) => /^Launched /.test(alert.text)).length;
  const settle = async (ref: string) => {
    for (let i = 0; i < 100 && !notices.some((notice) => notice.ref === ref && notice.type === "parked"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(notices.some((notice) => notice.ref === ref && notice.type === "parked"), `expected parked for ${ref}`);
  };

  // Every installed package is in the menu, shipped ones included; invalid siblings are reported.
  await command!("", ctx);
  assert.match(last(/broken: description is required/) ?? "", /broken/);
  assert.deepEqual(selects.at(-1)!.map((label) => label.split(" · ").slice(0, 2).join(" · ")), ["docs · read", "execute · write", "plan · read", "shared · read"]);
  assert.match(selects.at(-1)![0], /docs · read · user-only · Write the docs/);
  assert.match(overlays.at(-1)!, /Configure SDK agent · docs[\s\S]*Harness: ‹ pi ›[\s\S]*Enter launch · Esc cancel/);
  assert.doesNotMatch(overlays.at(-1)!, /\d+s ·/, "no countdown");
  assert.equal(launchedRef(), "docs-run");
  await settle("docs-run");
  assert.ok(TOOLS.every((name) => active.includes(name)), "all four Main tools are active after a user launch");
  assert.deepEqual(entries.at(-1)?.data, { on: true });
  // Empty instructions run the package as written.
  assert.equal(tasks.at(-1), "Run the docs workflow on this repository and submit its result.");
  assert.deepEqual(inputs.at(-1), { title: "Launch docs: instructions (optional)", placeholder: "Leave empty to run the package as written" });

  // The model sees model-invocable packages with their policies; kind is checked against the catalog, not an enum.
  const spawn = tools.find((tool) => tool.name === "worq_spawn")!;
  assert.equal(spawn.parameters.properties!.kind.enum, undefined);
  assert.match(spawn.description, /shared \(read\): Shared docs/);
  assert.match(spawn.description, /plan \(read, reviewed\)/);
  assert.doesNotMatch(spawn.description, /Write the docs/, "user-only packages are not offered to the model");
  await assert.rejects(spawn.execute("id", { kind: "docs", title: "Docs", task: "x" }, undefined, undefined, ctx), /user-only/);
  await command!("cancel docs-run", ctx);

  // Instructions become the task; the title comes from them.
  answer = "Focus on the CLI reference";
  await command!("workflow", ctx);
  assert.equal(launchedRef(), "focus-on-the-cli");
  await settle("focus-on-the-cli");
  assert.equal(tasks.at(-1), "Focus on the CLI reference");
  await command!("cancel focus-on-the-cli", ctx);

  // Cancelling at any step changes neither tools nor agents, even while off.
  await command!("off", ctx);
  const before = { launches: launches(), entries: entries.length, active: [...active] };
  const unchanged = () => {
    assert.equal(launches(), before.launches);
    assert.equal(entries.length, before.entries);
    assert.deepEqual(active, before.active);
  };
  choose = undefined;
  await command!("", ctx); unchanged();
  choose = "docs"; answer = undefined;
  await command!("", ctx); unchanged();
  answer = ""; keys = ["\x1b"];
  await command!("", ctx); unchanged();
  keys = ["\r", "n"];
  await command!("", ctx); unchanged();
  assert.match(overlays.at(-1)!, /Worq is off[\s\S]*re-enables worq_spawn/);

  // `workflow` takes no arguments.
  await command!("workflow extra", ctx);
  assert.equal(last(/^Usage: \/worq$/), "Usage: /worq");
  unchanged();

  // Off: a confirmed user launch re-enables all four tools; Main's spawn stays blocked until then.
  await assert.rejects(spawn.execute("id", { kind: "shared", title: "Shared docs", task: "blocked" }, undefined, undefined, ctx), /off/);
  keys = ["\r", "y"];
  await command!("", ctx);
  assert.equal(launchedRef(), "docs-run-2");
  await settle("docs-run-2");
  assert.ok(TOOLS.every((name) => active.includes(name)));
  await command!("cancel docs-run-2", ctx);

  // Non-TUI sessions have no selector: bare /worq only enables the tools.
  await command!("off", ctx);
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as never;
  try { await command!("", { ...ctx, mode: "rpc" }); }
  finally { process.stderr.write = write; }
  assert.match(stderr, /Worq tools enabled/);
  assert.ok(TOOLS.every((name) => active.includes(name)));
});

test("dispatch validates arguments against the shared schema", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq } = setup(root, state, {});
  const table = ops();
  assert.deepEqual(Object.keys(table.spawn.properties).sort(), ["attach", "kind", "model", "sdk", "task", "thinking", "title"]);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "review", title: "Surface test", task: "x" }), /Unknown kind review/);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "plan", title: "Surface test", task: "x", verify: "no" }), /verify must be boolean/);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "plan", title: "Surface test", task: "x", verify: false }), /verify:false is no longer supported/);
  assert.equal(worq.size, 0, "a refused spawn leaves no agent");
  await assert.rejects(dispatch(worq, table, "send", { ref: "zz", text: "x" }), /ref/);
  await assert.rejects(dispatch(worq, table, "nope", {}), /Unknown operation/);
  assert.match((await dispatch(worq, table, "list", {})).text, /No Worq agents/);
  const socket = await serve(state, (op, args) => dispatch(worq, table, op, args));
  await socket.close();
  assert.ok(Type.Object({}));
});
