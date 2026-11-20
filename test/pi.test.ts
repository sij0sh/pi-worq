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
import { observePty } from "../src/pty.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const packagePath = dirname(extension);
const options = ["--offline", "-ns", "--no-session", "--model", "worq-test/test"];
const invocation = [cli, ...options, "-ne", "-e", extension];
const contract = { outcome: "Print OK", boundaries: [], assumptions: [], criteria: [{ id: "result", outcome: "The CLI prints OK" }] };
const guidance = "Observe the exact text the note command prints.";
const webApp = `from http.server import BaseHTTPRequestHandler, HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200)\n  self.end_headers()\n  self.wfile.write(b'OK')\nsrv = HTTPServer(('127.0.0.1', 0), Handler)\nprint(f'READY {srv.server_port}', flush=True)\nsrv.serve_forever()\n`;
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
  await Promise.all([cwd, config, home].map(async (path) => { await mkdir(path, { recursive: true }); }));
  const journal: string[] = [], failures: string[] = [], managed: string[] = [], reviews: string[] = [], piMessages: string[] = [];
  const calls: { role: string; model: string; trail: string[] }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const { messages, model, tools = [] } = JSON.parse(raw) as { messages: Message[]; model: string; tools?: { function: { name: string } }[] };
      const prompt = bodyText(messages[0].content);
      const user = bodyText(messages.find((item) => item.role === "user")?.content ?? "");
      const latest = bodyText(messages.findLast((item) => item.role === "user")?.content ?? "");
      const trail = messages.flatMap((item) => (item.tool_calls ?? []).map((call) => call.function.name));
      const last = messages.at(-1);
      const role = /^# Role: ([^\n]+)/m.exec(prompt)?.[1] ?? "Pi";
      calls.push({ role: role === "Lens" ? /^# (\w+)$/m.exec(prompt)![1] : role, model, trail });
      const available = tools.map((entry) => entry.function.name);
      if (role === "Pi") piMessages.push(...messages.map((entry) => bodyText(entry.content)));
      if (last?.role === "tool") journal.push(bodyText(last.content));
      if (prompt.includes("# Role: Plan")) {
        assert.ok(available.includes("write_artifact"));
        for (const forbidden of ["write_file", "run_command", "start_job"]) assert.ok(!available.includes(forbidden));
        const plan = submit({ mode: "change", contract, summary: "Update output", steps: ["Edit app.py"], verificationNote: guidance });
        if (user.includes("Slow note")) { await sleep(2000); if (response.destroyed) return; }
        if (user.includes("Audit")) {
          const writes = trail.filter((name) => name === "write_artifact").length;
          if (!trail.includes("read_file")) delta(response, { name: "read_file", args: { path: "app.py" } });
          else if (writes === 0) delta(response, { name: "write_artifact", args: { name: "../../outside.md", content: "This must not be written" } });
          else if (writes === 1) delta(response, { name: "write_artifact", args: { name: "audit.md", content: "# Audit\n\n`app.py:1` prints a fixed value." } });
          else delta(response, submit({ mode: "report", summary: "Found hardcoded output" }));
        } else if (user.includes("Quick answer")) delta(response, submit({ mode: "report", summary: "One-line answer" }));
        else if (user.includes("Reject")) {
          if (!trail.includes("worq_submit")) delta(response, submit({ mode: "change", summary: "Missing contract" }));
          else { if (latest !== user) assert.match(latest, /Worq rejected your submission: Change plan needs a contract/); delta(response, "Nothing more to add."); }
        } else if (user.includes("Settle") && !latest.includes("without calling worq_submit")) delta(response, "Approach is obvious.");
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
        else if (!trail.includes("write_file")) {
          const content = user.includes("TTY note") ? "print('READY', flush=True)\nif input() == 'go': print('OK', flush=True)\ninput()\n"
            : user.includes("Web note") ? webApp : user.includes("Wrong note") ? "print('STILL WRONG')\n" : "print('OK')\n";
          delta(response, { name: "write_file", args: { path: "app.py", content } });
        } else if (model === "broken") response.writeHead(503).end("Model unavailable");
        else if (!trail.includes("run_command")) delta(response, { name: "run_command", args: { executable: "/usr/bin/true", args: [] } });
        else delta(response, submit({ summary: "Updated app" }));
      } else if (prompt.includes("# Role: Verify")) {
        assert.ok(!user.includes("Update output"));
        for (const forbidden of ["write_file", "write_artifact", "ask_manager", "edit_file"]) assert.ok(!available.includes(forbidden));
        const task = JSON.parse(user) as { request: string; contract: { request: string }; verificationNote: string; commit: string };
        assert.ok(task.request.includes("note"));
        assert.equal(task.contract.request, task.request);
        assert.match(task.commit, /^[a-f\d]{40}$/);
        assert.equal(task.verificationNote, guidance);
        if (user.includes("Web note")) {
          const ready = messages.map((entry) => bodyText(entry.content)).join("\n").match(/READY (\d+)/);
          if (!trail.includes("start_local_service")) delta(response, { name: "start_local_service", args: { executable: "/usr/bin/python3", args: ["app.py"] } });
          else if (!ready) {
            assert.ok(trail.length < 8, "Service never became ready");
            await sleep(50);
            delta(response, { name: "service_status", args: { id: 1 } });
          } else if (user.includes("Cancel")) {
            await sleep(3500);
            if (!response.destroyed) delta(response, submit({ verdict: "inconclusive", summary: "Service not yet exercised" }));
          } else if (!trail.includes("run_command")) delta(response, { name: "run_command", args: { executable: "/usr/bin/python3", args: ["probe.py", ready[1]] } });
          else if (!trail.includes("save_artifact")) {
            assert.match(bodyText(last?.content ?? ""), /stdout:\nOK/);
            delta(response, { name: "save_artifact", args: { path: "observation.txt" } });
          } else delta(response, submit({ verdict: "pass", summary: `Saw OK on loopback port ${ready[1]}` }));
        } else if (user.includes("TTY note")) {
          if (!trail.includes("observe_terminal")) delta(response, { name: "observe_terminal", args: { executable: "/usr/bin/python3", args: ["app.py"],
            actions: [observe, type("go"), press("enter"), wait(120), observe] } });
          else {
            assert.match(bodyText(last?.content ?? ""), /Step 1:[\s\S]*READY[\s\S]*Step 5:[\s\S]*OK/);
            delta(response, submit({ verdict: "pass", summary: "Saw OK after typing go in the terminal" }));
          }
        } else if (!trail.includes("run_command")) delta(response, { name: "run_command", args: { executable: user.includes("Missing tool") ? "not-installed-worq-test" : "/usr/bin/python3", args: ["app.py"] } });
        else {
          const result = bodyText(last?.content ?? "");
          if (user.includes("Missing tool")) {
            assert.match(result, /ENOENT/);
            delta(response, submit({ verdict: "inconclusive", summary: "Needed tool is missing" }));
          } else {
            const output = /stdout:\n([^\n]+)/.exec(result)?.[1];
            assert.ok(output, result);
            delta(response, submit({ verdict: output === "OK" ? "pass" : "fail", summary: `Observed stdout: ${output}` }));
          }
        }
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
      } else if (latest === "hello pi") delta(response, "PI-CHAT-REPLY");
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
  await writeFile(join(cwd, "probe.py"), "from pathlib import Path\nfrom urllib.request import urlopen\nimport sys\nresult = urlopen(f'http://127.0.0.1:{sys.argv[1]}', timeout=2).read().decode()\nPath('observation.txt').write_text(result)\nprint(result)\n");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=fixture", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "app.py", "probe.py"); git("commit", "-qm", "baseline");
  const staleProfile = async () => {
    await mkdir(dirname(profile), { recursive: true });
    await writeFile(profile, '{"repository":' + JSON.stringify(cwd) + ',"entry":"nonexistent.py"}');
    return profile;
  };
  const env = { ...cleanEnv, PI_CODING_AGENT_DIR: config, XDG_CONFIG_HOME: xdg, WORQ_STATE_DIR: state, HOME: home, TERM: "xterm-256color" };
  const records = async () => Promise.all((await readdir(state)).filter((name) => name !== "ctl").map(async (name) => JSON.parse(await readFile(join(state, name, "run.json"), "utf8"))));
  const configure = (value: object) => writeFile(join(config, "pi-worq.json"), JSON.stringify(value));
  return { cwd, env, journal, failures, records, git, managed, reviews, state, calls, configure, staleProfile, piMessages };
}

test("Pi loads the installed package; print mode skips lenses without a Pi review", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const install = await runProcess(process.execPath, [cli, "install", packagePath], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(5_000), ms: 6000 });
  assert.equal(install.code, 0, install.stderr);
  const request = "Make the note print OK";
  const result = await runProcess(process.execPath, [cli, ...options, "-p", `/worq ${request}`], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(20_000), ms: 21_000 });
  assert.deepEqual(h.failures, [], JSON.stringify(h.failures) + result.stderr);
  assert.match(result.stderr, /PASS · Verify/, `${result.stdout}\n${result.stderr}\n${JSON.stringify(h.journal)}`);
  assert.match(result.stderr, /\[worq\] v\d+ · verify · PASS · Observed stdout: OK/);
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
  assert.match(result.stderr, /PASS · Verify/);
});

test("global config selects models and falls back without replaying completed tools", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  await h.configure({ model: "worq-test/default", fallbackModel: "worq-test/backup", agents: {
    plan: { model: "worq-test/plan" }, execute: { model: "worq-test/broken", fallbackModel: "worq-test/override-backup" },
  } });
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Make the note print OK"], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.deepEqual(h.failures, []);
  assert.match(result.stderr, /PASS · Verify/);
  assert.deepEqual(h.calls.filter((c) => c.role === "Plan").map((c) => c.model), ["plan"]);
  assert.deepEqual(h.calls.filter((c) => c.role === "Verify").map((c) => c.model), ["default", "default"]);
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

test("profile-less audit saves a scoped Markdown artifact and ends after Plan", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const profile = await h.staleProfile();
  const before = await readFile(profile, "utf8");
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Audit the note app and save a Markdown report"], { cwd: h.cwd, env: { ...h.env, WORQ_PROFILE: profile }, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.deepEqual(h.failures, [], result.stderr);
  assert.match(result.stderr, /REPORT READY · Plan/);
  assert.doesNotMatch(result.stderr, /\bPASS\b/);
  const [record] = await h.records();
  assert.deepEqual(record.path, ["1 · Plan"]);
  const [entry] = record.reports;
  assert.equal(entry.summary, "Found hardcoded output");
  assert.equal(entry.artifacts.length, 1);
  assert.match(entry.artifacts[0], /\.agents\/artifacts\/plan-1\/audit\.md$/);
  assert.match(result.stderr, /Artifact: .*audit\.md/);
  assert.match(await readFile(entry.artifacts[0], "utf8"), /app\.py:1/);
  await assert.rejects(readFile(join(record.directory, ".agents", "outside.md")), { code: "ENOENT" });
  assert.equal(await readFile(profile, "utf8"), before);
  assert.equal(h.git("branch", "--list", "worq/*"), "");
  assert.equal(h.git("status", "--porcelain"), "");
  assert.ok(h.calls.every((c) => c.role === "Plan"));
});

test("Pi surfaces the rejected submission, not a generic missing result", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Reject the note output"], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.deepEqual(h.failures, [], result.stderr);
  assert.match(result.stderr, /Reason: submission-rejected/);
  const [record] = await h.records();
  assert.match(record.activity, /Change plan needs a contract/);
});

for (const [request, verdict, detail] of [
  ["Fix the Wrong note", "FAIL", /Observed stdout: STILL WRONG/],
  ["Fix the Missing tool note", "INCONCLUSIVE", /Needed tool is missing/],
  ["Fix the TTY note", "PASS", /Saw OK after typing go in the terminal/],
] as const) {
  test(`Pi Verify reports ${verdict} for ${request}`, { timeout: 20_000 }, async (t) => {
    const h = await harness(t);
    const result = await runProcess(process.execPath, [...invocation, "-p", `/worq ${request}`], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
    assert.deepEqual(h.failures, [], result.stderr);
    assert.match(result.stderr, new RegExp(`${verdict} · Verify`));
    assert.match(result.stderr, detail);
    const [record] = await h.records();
    assert.equal(record.reports.at(-1).verdict, verdict.toLowerCase());
    assert.equal(record.reports.at(-1).commit, record.candidate);
  });
}

test("Verify can exercise a managed local service, retain an observation, and stop the service", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const result = await runProcess(process.execPath, [...invocation, "-p", "/worq Fix the Web note"], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(15_000), ms: 16_000 });
  assert.deepEqual(h.failures, [], result.stderr);
  assert.match(result.stderr, /PASS · Verify/);
  const [record] = await h.records();
  const entry = record.reports.at(-1);
  assert.match(entry.summary, /Saw OK on loopback port (\d+)/);
  assert.equal(await readFile(entry.artifacts[0], "utf8"), "OK");
  const port = entry.summary.split(" ").at(-1);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }), (error: unknown) =>
    error instanceof Error && (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED");
});

test("stopping Verify joins its local service before marking the run cancelled", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const screens = await observePty(process.execPath, invocation, [
    wait(1400), type("/worq --no-lenses Cancel Web note"), press("enter"), wait(1450), observe,
    type("\x1bx"), wait(650), observe,
  ], h.cwd, h.env, AbortSignal.timeout(15_000));
  assert.deepEqual(h.failures, []);
  assert.match(screens[0].screen, /Independently testing the candidate/);
  assert.match(screens[1].screen, /CANCELLED/);
  const [record] = await h.records();
  assert.equal(record.state, "cancelled");
  assert.ok(record.reports.every((entry: { verdict?: string }) => !entry.verdict));
  const port = h.journal.map((entry) => /READY (\d+)/.exec(entry)?.[1]).find(Boolean);
  assert.ok(port, "No managed service became ready");
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }), (error: unknown) =>
    error instanceof Error && (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED");
});

test("a small report reaches main Pi without triggering a model turn", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const screens = await observePty(process.execPath, invocation, [
    wait(1400), type("/worq Quick answer about the note"), press("enter"), wait(650), observe,
    type("hello pi"), press("enter"), wait(550), observe,
  ], h.cwd, h.env, AbortSignal.timeout(15_000));
  assert.deepEqual(h.failures, []);
  assert.match(screens[0].screen, /REPORT READY/);
  assert.match(screens[1].screen, /PI-CHAT-REPLY/);
  assert.equal(h.calls.filter(({ role }) => role === "Pi").length, 1);
  assert.ok(h.piMessages.some((entry) => /\[worq\] p\d+ · plan · One-line answer/.test(entry)));
  const [record] = await h.records();
  assert.deepEqual(record.reports.map(({ summary }: { summary: string }) => summary), ["One-line answer"]);
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`Pi ${mode}: typed answer, keyboard inspector, resize and editor`, { timeout: 25_000 }, async (t) => {
    const h = await harness(t, mode);
    if (mode === "fullscreen") await h.configure({ model: "worq-test/default", fallbackModel: "worq-test/backup", scq: { pair: { model: "worq-test/pair" } } });
    const screens = await observePty(process.execPath, invocation, [
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
    assert.match(text[3], /Observed stdout: OK/);
    assert.match(text[4], /unfinished draft/);
    const [record] = await h.records();
    assert.equal(record.state, "pass");
    // Main Pi managed the run: escalated Plan's intent question, reviewed plan and candidate, and answered the executor.
    assert.ok(h.managed.filter((id) => id.startsWith("g")).length >= 2, JSON.stringify(h.managed));
    assert.ok(h.journal.includes("User: OK"), JSON.stringify(h.journal));
    assert.ok(h.journal.includes("Manager: Print OK exactly"), JSON.stringify(h.journal));
    assert.ok(record.path.some((step: string) => step.includes("plan review: approved")), JSON.stringify(record.path));
    assert.ok(record.agents.some((agent: { role: string; sealed: boolean }) => agent.role === "verify" && agent.sealed));
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
  const screens = await observePty(process.execPath, invocation, [
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
