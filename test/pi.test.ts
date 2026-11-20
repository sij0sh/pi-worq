import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Action } from "../src/contracts.ts";
import { cleanEnv, runProcess } from "../src/process.ts";
import { journeyPty } from "../src/pty.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const packagePath = dirname(extension);
const options = ["--offline", "-ns", "--no-session", "--model", "worq-test/test"];
const invocation = [cli, ...options, "-ne", "-e", extension];
const contract = { outcome: "Print OK", boundaries: [], assumptions: [], criteria: [{ id: "result", outcome: "The CLI prints OK", checks: ["output"] }] };
type Message = { role: string; content: string | { text?: string }[] | null; tool_calls?: { function: { name: string } }[] };
const bodyText = (content: Message["content"]) => typeof content === "string" ? content : (content ?? []).map((p) => p.text ?? "").join("");
function delta(response: ServerResponse, payload: string | { name: string; args: object }) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const tool = typeof payload !== "string";
  const part = tool ? { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: payload.name, arguments: JSON.stringify(payload.args) } }] } : { content: payload };
  const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test-stream", created: 1, model: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(chunk({ role: "assistant", ...part }, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
}
const submit = (args: object) => ({ name: "worq_submit", args });
async function harness(t: TestContext, mode: "regular" | "fullscreen" = "fullscreen") {
  const dir = await mkdtemp(join(tmpdir(), "worq-pi-"));
  const cwd = join(dir, "repo"), config = join(dir, "agent"), xdg = join(dir, "xdg"), profile = join(xdg, "pi-worq", "profiles", "repo.json"), state = join(dir, "state"), home = join(dir, "home");
  await Promise.all([cwd, config, home, dirname(profile)].map(async (path) => { await mkdir(path, { recursive: true }); }));
  const journal: string[] = [], failures: string[] = [], managed: string[] = [], reviews: string[] = [];
  const calls: { role: string; model: string; trail: string[] }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const { messages, model } = JSON.parse(raw) as { messages: Message[]; model: string };
      const prompt = bodyText(messages[0].content);
      const user = bodyText(messages.find((item) => item.role === "user")?.content ?? "");
      const latest = bodyText(messages.findLast((item) => item.role === "user")?.content ?? "");
      const trail = messages.flatMap((item) => (item.tool_calls ?? []).map((call) => call.function.name));
      const last = messages.at(-1);
      const role = /^# Role: ([^\n]+)/m.exec(prompt)?.[1] ?? "Pi";
      calls.push({ role: role === "Lens" ? /^# (\w+)$/m.exec(prompt)![1] : role, model, trail });
      if (last?.role === "tool") journal.push(bodyText(last.content));
      if (prompt.includes("# Role: Plan")) {
        assert.ok(!prompt.includes("start_job"));
        assert.ok(!trail.includes("start_job"));
        const plan = submit({ contract, summary: "Update output", steps: ["Edit app.py"] });
        if (user.includes("Slow note")) { await sleep(2000); if (response.destroyed) return; }
        if (user.includes("Settle") && !latest.includes("without calling worq_submit")) delta(response, "Approach is obvious.");
        else if (user.includes("Clarify") && !trail.includes("ask_manager")) delta(response, { name: "ask_manager", args: { question: "Which text should the CLI print?" } });
        else delta(response, plan);
      } else if (prompt.includes("# Role: Lens")) {
        const task = JSON.parse(user) as { request: string; contract: { request: string }; plan: { steps: string[] } };
        assert.equal(task.contract.request, task.request);
        assert.deepEqual(task.plan.steps, ["Edit app.py"]);
        if (model === "pair") response.writeHead(503).end("Model unavailable");
        else delta(response, submit({ summary: prompt.includes("# Defeater") ? "Trailing newline unverified" : "No consequential findings" }));
      } else if (prompt.includes("# Role: Execute")) {
        if (user.includes("Clarify") && !trail.includes("ask_manager")) delta(response, { name: "ask_manager", args: { question: "Exact output?" } });
        else if (!trail.filter((name) => name !== "ask_manager").length) delta(response, { name: "write_file", args: { path: "app.py", content: "print('OK')\n" } });
        else if (model === "broken") response.writeHead(503).end("Model unavailable");
        else if (!trail.includes("dev_check")) delta(response, { name: "dev_check", args: { id: "simple" } });
        else delta(response, submit({ summary: "Updated app" }));
      } else if (prompt.includes("# Role: Verify journey")) {
        assert.ok(!user.includes("Update output"));
        const task = JSON.parse(user) as { request: string; contract: { request: string } };
        assert.ok(task.request.includes("note"));
        assert.equal(task.contract.request, task.request);
        delta(response, submit({ cases: [{ check: "output", scenario: "default" }] }));
      } else if (last?.role === "tool" && trail.at(-1)?.startsWith("worq_")) delta(response, "Done.");
      else if (/\[worq\] (g\d+) · \w+ review/.test(latest)) {
        const id = /\[worq\] (g\d+)/.exec(latest)![1];
        managed.push(id);
        reviews.push(latest);
        delta(response, { name: "worq_review", args: { id, decision: "approve" } });
      } else if (/\[worq\] (q\d+) · agent/.test(latest)) {
        const id = /\[worq\] (q\d+)/.exec(latest)![1];
        managed.push(id);
        // Intent questions belong to the user; tactical ones Pi answers.
        if (latest.includes("Which text")) delta(response, { name: "worq_escalate", args: { id } });
        else delta(response, { name: "worq_reply", args: { id, text: "Print OK exactly" } });
      } else if (user === "hello pi") delta(response, "PI-CHAT-REPLY");
      else throw new Error(`Unexpected prompt: ${prompt.slice(0, 300)}`);
    } catch (error) { failures.push(String(error)); response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { "worq-test": { api: "openai-completions", apiKey: "offline-test", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["test", "default", "plan", "pair", "broken", "backup", "override-backup"].map((id) => ({ id, name: id, reasoning: false })) } } }));
  await writeFile(join(config, "settings.json"), JSON.stringify({ tuiMode: mode, quietStartup: true }));
  await writeFile(join(cwd, "app.py"), "print('WRONG')\n");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=fixture", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "app.py"); git("commit", "-qm", "baseline");
  await writeFile(profile, JSON.stringify({ version: 1, repository: cwd, trustLocalCode: true, surface: "cli", entry: "app.py", interpreter: "/usr/bin/python3",
    devChecks: [{ id: "simple", executable: "/usr/bin/true", args: [] }],
    checks: [{ id: "output", outcome: "Standard output is exactly OK", scenarios: [{ id: "default", name: "Run app", args: [], expect: [{ channel: "stdout", op: "equals", value: "OK\n" }] }] }] }), { mode: 0o600 });
  const env = { ...cleanEnv, PI_CODING_AGENT_DIR: config, XDG_CONFIG_HOME: xdg, WORQ_STATE_DIR: state, HOME: home, TERM: "xterm-256color" };
  const records = async () => Promise.all((await readdir(state)).filter((name) => name !== "ctl").map(async (name) => JSON.parse(await readFile(join(state, name, "run.json"), "utf8"))));
  const configure = (value: object) => writeFile(join(config, "pi-worq.json"), JSON.stringify(value));
  return { cwd, env, journal, failures, records, git, managed, reviews, state, calls, configure };
}

test("Pi loads the installed package; print mode skips lenses without a Pi review", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const install = await runProcess(process.execPath, [cli, "install", packagePath], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(5_000), ms: 6000 });
  assert.equal(install.code, 0, install.stderr);
  const request = "Make the note print OK";
  const result = await runProcess(process.execPath, [cli, ...options, "-p", `/worq ${request}`], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(20_000), ms: 21_000 });
  assert.deepEqual(h.failures, [], JSON.stringify(h.failures) + result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /PASS · Verify · 1\/1 observed/, `${result.stdout}\n${result.stderr}\n${JSON.stringify(h.journal)}`);
  const [record] = await h.records();
  assert.equal(record.request, request);
  assert.deepEqual(record.jobs, []);
  assert.ok(record.path.includes("1 · lenses skipped: no Pi plan review"), JSON.stringify(record.path));
  assert.equal(h.git("status", "--porcelain"), "");
});

test("an agent that stops without submitting gets one settlement turn", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Settle the note output"], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.deepEqual(h.failures, [], JSON.stringify(h.failures) + result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /PASS · Verify · 1\/1 observed/);
});

test("global config selects models and falls back without replaying completed tools", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  await h.configure({ model: "worq-test/default", fallbackModel: "worq-test/backup", agents: {
    plan: { model: "worq-test/plan" }, execute: { model: "worq-test/broken", fallbackModel: "worq-test/override-backup" },
  } });
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Make the note print OK"], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.deepEqual(h.failures, []);
  assert.match(`${result.stdout}\n${result.stderr}`, /PASS · Verify · 1\/1 observed/);
  assert.deepEqual(h.calls.filter((c) => c.role === "Plan").map((c) => c.model), ["plan"]);
  assert.deepEqual(h.calls.filter((c) => c.role === "Verify journey").map((c) => c.model), ["default"]);
  const execute = h.calls.filter((c) => c.role === "Execute");
  assert.deepEqual(execute.map((c) => c.model), ["broken", "broken", "override-backup", "override-backup"]);
  assert.deepEqual(execute[2].trail, ["write_file"]);
});

test("unknown models in the global config are reported before starting a run", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  await h.configure({ model: "worq-test/typo" });
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Make the note print OK"], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.match(result.stderr, /pi-worq\.json: Pi does not know model worq-test\/typo/);
  assert.deepEqual(h.calls, []);
});

const type = (text: string): Action => ({ type: "type", text });
const press = (key: Extract<Action, { type: "press" }>["key"]): Action => ({ type: "press", key });
const wait = (ms: number): Action => ({ type: "wait", ms });
const observe: Action = { type: "observe" };
for (const mode of ["regular", "fullscreen"] as const) {
  test(`Pi ${mode}: typed answer, keyboard inspector, resize and editor`, { timeout: 25_000 }, async (t) => {
    const h = await harness(t, mode);
    if (mode === "fullscreen") await h.configure({ model: "worq-test/default", fallbackModel: "worq-test/backup", scq: { pair: { model: "worq-test/pair" } } });
    const screens = await journeyPty(process.execPath, invocation, [
      wait(1400), type("/worq Clarify the note"), press("enter"), wait(800), observe,
      type("OK"), press("enter"), wait(1000), observe, type("/worq status"), press("enter"), wait(450), observe,
      press("down"), press("down"), press("down"), press("down"), press("enter"), wait(150), observe,
      press("escape"), wait(150), press("escape"), wait(150), type("unfinished draft"), { type: "resize", cols: 45, rows: 20 }, wait(250), observe,
    ], h.cwd, h.env, AbortSignal.timeout(20_000));
    const text = screens.map((entry) => entry.screen);
    assert.deepEqual(h.failures, []);
    assert.match(text[0], /needs you/);
    assert.match(text[0], /Which text should the CLI print\?/);
    assert.match(text[1], /PASS/);
    assert.doesNotMatch(text[1], /needs you/);
    assert.match(text[2], /Worq status/);
    assert.match(text[3], /Expected: stdout equals/);
    assert.match(text[4], /unfinished draft/);
    const [record] = await h.records();
    assert.equal(record.state, "pass");
    // Main Pi managed the run: escalated Plan's intent question, reviewed plan and candidate, and answered the executor.
    assert.ok(h.managed.filter((id) => id.startsWith("g")).length >= 2, JSON.stringify(h.managed));
    assert.ok(h.journal.includes("User: OK"), JSON.stringify(h.journal));
    assert.ok(h.journal.includes("Manager: Print OK exactly"), JSON.stringify(h.journal));
    assert.ok(record.path.some((step: string) => step.includes("plan review: approved")), JSON.stringify(record.path));
    assert.ok(record.agents.some((agent: { role: string; sealed: boolean }) => agent.role === "journey" && agent.sealed));
    // Lenses fired on the finished plan without Plan asking; Pi saw their findings in the plan review.
    assert.deepEqual(record.jobs.map((job: { kind: string; state: string }) => [job.kind, job.state]),
      [["lens:decision", "done"], ["lens:defeater", "done"], ["lens:pair", "done"], ["lens:subtraction", "done"]]);
    if (mode === "fullscreen") {
      assert.deepEqual(h.calls.filter((c) => c.role === "Pair").map((c) => c.model), ["pair", "backup"]);
      assert.deepEqual(h.calls.filter((c) => c.role === "Defeater").map((c) => c.model), ["default"]);
      assert.ok(h.calls.filter((c) => c.role === "Pi").every((c) => c.model === "test"));
    }
    assert.ok(h.reviews.some((body) => /plan review[\s\S]*Lens findings[\s\S]*\[defeater\] Trailing newline unverified/.test(body)), JSON.stringify(h.reviews));
  });
}

test("bare /worq opens an editor; chat passes through; stop shortcut joins the run", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const screens = await journeyPty(process.execPath, invocation, [
    wait(1400), type("/worq"), press("enter"), wait(250), observe,
    type("Slow note"), press("enter"), wait(300), observe,
    type("hello pi"), press("enter"), wait(400), observe,
    { type: "type", text: "\x1bx" }, wait(450), observe,
  ], h.cwd, h.env, AbortSignal.timeout(15_000));
  assert.match(screens[0].screen, /What outcome should Worq deliver\?/);
  assert.match(screens[1].screen, /Framing the contract and approach/);
  assert.match(screens[2].screen, /PI-CHAT-REPLY/);
  assert.match(screens[3].screen, /CANCELLED/);
  const [record] = await h.records();
  assert.equal(record.state, "cancelled");
  assert.equal(h.git("branch", "--list", "worq/*"), "");
});
