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

test("shipped Plan, Execute and Scout are ordinary packages; workflow-owned role files", () => {
  assert.deepEqual([...KINDS.keys()].sort(), ["execute", "plan", "scout"]);
  assert.equal(KINDS.get("plan")!.access, "read");
  assert.equal(KINDS.get("plan")!.output, "plan");
  assert.equal(KINDS.get("execute")!.access, "write");
  assert.equal(KINDS.get("scout")!.access, "read");
  assert.equal(KINDS.get("scout")!.output, "inline");
  assert.deepEqual(KINDS.get("scout")!.limits, { turns: 16, minutes: 5, asks: 0 });
  assert.ok([...KINDS.values()].every((kind) => !kind.userOnly && kind.skill));
  assert.match(KINDS.get("execute")!.review!, /What consequential reason is there not to accept this result as-is\?/);
});

test("one command, four active tools and CLI socket integration", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(agentDir);
  await writeFile(join(agentDir, "pi-worq.json"), JSON.stringify({ limits: { agentTurns: 2, reviewerTurns: 2 } }));
  process.env.WORQ_STATE_DIR = state;
  const tools: { name: string; defaultActive?: boolean; parameters: unknown; execute: Function }[] = [];
  const handlers: Record<string, Function> = {};
  let command: Function | undefined;
  let renderNotice: Function | undefined;
  const notices: { message: { content: string; customType: string; details: { ref: string; type?: string } }; options: { triggerTurn: boolean; deliverAs?: string } }[] = [];
  const alerts: string[] = [];
  const requests: string[] = [];
  const pi = {
    sendUserMessage: (text: string) => requests.push(text),
    registerTool: (tool: never) => tools.push(tool),
    registerCommand(name: string, options: {handler: Function}) { assert.equal(name,"worq"); assert.equal(command,undefined); command = options.handler; },
    registerMessageRenderer(_name: string, renderer: Function) { renderNotice = renderer; },
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    sendMessage: (message: typeof notices[number]["message"], options: typeof notices[number]["options"]) => notices.push({ message, options }),
  };
  const resumedReviews: string[] = [];
  const scripts: Record<string, Script> = {
    "agent.plan": async turn => {
      if (turn.text.startsWith("Main: Remove the watcher")) {
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
  assert.ok(tools.every(t => t.defaultActive));
  let widget: { render(width: number): string[] } | undefined;
  const ctx = { mode: "tui", cwd: root, ui: { notify(text: string) { alerts.push(text); }, setStatus() {},
    setWidget(key: string, factory?: Function) {
      if (key !== "worq") return;
      widget = factory?.({ requestRender() {} }, { fg: (_: string, value: string) => value });
    },
  } };
  await command!("on",ctx); assert.deepEqual(requests,[]); assert.deepEqual(alerts,["Usage: /worq"]);
  await handlers.session_start({}, ctx);

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
  const send = tools.find(t => t.name === "worq_send")!; await send.execute("id",{ref,text:"Use HELLO"},undefined,undefined,ctx);
  const ready = await waitFor("parked");
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
  const nextRef = "surface-test-2";
  const launched = await run(process.execPath, [cli, "spawn", "plan", "--title", "Surface test", "--attach", ref, "--attach", `.agents/plans/plan-${ref}.md`, "Simplify the report"], { env });
  assert.match(launched.stdout, /Surface test \(surface-test-2\).*plan-surface-test\.md/);
  const waitFor2 = async (type: string) => {
    const ready = () => notices.some(({ message }) => message.details.ref === nextRef && message.details.type === type);
    for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(ready(), `expected ${type}`);
  };
  await waitFor2("parked");
  await send.execute("id",{ref:nextRef,text:"Remove the watcher"},undefined,undefined,ctx);
  await waitFor2("done");
  assert.equal(resumedReviews.length, 1, "one review per agent; the feedback revision is not re-reviewed");
  assert.doesNotMatch(resumedReviews[0], /no background process/);
  assert.match((await run(process.execPath, [cli, "list", nextRef], { env })).stdout, / · done\b/);
  assert.doesNotMatch((await run(process.execPath, [cli, "list"], { env })).stdout, / · execute · /);
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

test("/worq launches a user-only package", async (t) => {
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
  const notices: { content: string; type?: string; ref: string }[] = [];
  const alerts: { text: string; level: string }[] = [];
  const tasks: string[] = [];
  const pi = {
    sendUserMessage: () => {},
    registerTool: (tool: never) => tools.push(tool),
    registerCommand: (name: string, options: { handler: Function }) => { if (name === "worq") command = options.handler; },
    registerMessageRenderer() {},
    on() {},
    sendMessage: (message: { content: string; details: { ref: string; type?: string } }) => notices.push({ content: message.content, type: message.details.type, ref: message.details.ref }),
  };
  const record = async (turn: { text: string; tool(name: string, params: object): Promise<string> }) => { tasks.push(JSON.parse(turn.text).task); await turn.tool("submit", planSubmission); };
  createWorq({ agentDir: () => agentDir, driver: () => fakeDriver({ "agent.docs": record, "agent.shared": record }) })(pi as never);
  const ctx = {
    mode: "tui", cwd: root,
    ui: {
      notify: (text: string, level: string) => alerts.push({ text, level }),
      setWidget(key: string, factory?: Function) {
        if (!factory || key !== 'worq-launch') return;
        const panel = factory({terminal:{rows:24},requestRender(){},getFocusedComponent(){return null;},setFocus(){}},{});
        for (const key of ['\x1b[B','\x1b[B','\r','\r','\r']) panel.handleInput(key);
      },
    },
  };
  const last = (pattern: RegExp) => alerts.map((alert) => alert.text).filter((text) => pattern.test(text)).at(-1);
  const launchedRef = () => /as ([a-z0-9-]+)\./.exec(last(/^Launched /) ?? "")?.[1];
  const settle = async (ref: string) => {
    for (let i = 0; i < 100 && !notices.some((notice) => notice.ref === ref && notice.type === "done"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(notices.some((notice) => notice.ref === ref && notice.type === "done"), `expected done for ${ref}`);
  };

  // Plan and Execute come first, followed by custom packages alphabetically; invalid siblings are reported.
  await command!("", ctx);
  assert.match(last(/broken: description is required/) ?? "", /broken/);
  assert.equal(launchedRef(), "docs-run");
  await settle("docs-run");
  // Empty instructions run the package as written.
  assert.equal(tasks.at(-1), "Run the docs workflow on this repository and submit its result.");

  // The model sees model-invocable packages with their policies; kind is checked against the catalog, not an enum.
  const spawn = tools.find((tool) => tool.name === "worq_spawn")!;
  assert.equal(spawn.parameters.properties!.kind.enum, undefined);
  assert.match(spawn.description, /shared \(read\): Shared docs/);
  assert.match(spawn.description, /plan \(read\)/);
  assert.doesNotMatch(spawn.description, /Write the docs/, "user-only packages are not offered to the model");
  await assert.rejects(spawn.execute("id", { kind: "docs", title: "Docs", task: "x" }, undefined, undefined, ctx), /user-only/);
});

test("dispatch validates arguments against the shared schema", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq } = setup(root, state, {});
  const table = ops();
  assert.deepEqual(Object.keys(table.spawn.properties).sort(), ["attach", "expect", "gates", "group", "kind", "model", "notify", "sdk", "task", "thinking", "title", "writePaths"]);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "review", title: "Surface test", task: "x" }), /Unknown kind review/);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "plan", title: "Surface test", task: "x", verify: "no" }), /verify|additional/i);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "plan", title: "Surface test", task: "x", verify: false }), /verify|additional/i);
  assert.equal(worq.size, 0, "a refused spawn leaves no agent");
  await assert.rejects(dispatch(worq, table, "send", { ref: "zz", text: "x" }), /ref/);
  await assert.rejects(dispatch(worq, table, "nope", {}), /Unknown operation/);
  assert.match((await dispatch(worq, table, "list", {})).text, /No Worq agents/);
  const socket = await serve(state, (op, args) => dispatch(worq, table, op, args));
  await socket.close();
  assert.ok(Type.Object({}));
});
