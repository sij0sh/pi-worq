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
async function harness(t: TestContext, mode: "regular" | "fullscreen" = "fullscreen", useWorkers = false) {
  const dir = await mkdtemp(join(tmpdir(), "worq-pi-"));
  const cwd = join(dir, "repo"), config = join(dir, "agent"), profile = join(dir, "profile.json"), state = join(dir, "state"), home = join(dir, "home");
  await Promise.all([cwd, config, home].map(async (path) => { await mkdir(path); }));
  const journal: string[] = [], failures: string[] = [];
  let releaseWriter!: () => void;
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const { messages } = JSON.parse(raw) as { messages: Message[] };
      const prompt = bodyText(messages[0].content);
      const user = bodyText(messages.find((item) => item.role === "user")?.content ?? "");
      const trail = messages.flatMap((item) => (item.tool_calls ?? []).map((call) => call.function.name));
      const last = messages.at(-1);
      if (last?.role === "tool") journal.push(bodyText(last.content));
      if (prompt.includes("Capture intent")) {
        if (user.includes("Slow note")) { await sleep(2000); if (response.destroyed) return; }
        delta(response, JSON.stringify(user.includes("Clarify") && !user.includes('"answer"') ? { question: "Which text should the CLI print?" } : { contract }));
      } else if (prompt.includes("Design the shortest")) {
        if (useWorkers && !trail.length) delta(response, { name: "start_job", args: { kind: "read", task: "Confirm the current app output" } });
        else delta(response, submit({ summary: "Update output", steps: ["Edit app.py"] }));
      } else if (prompt.includes("Handle only the assigned")) {
        const { authority } = JSON.parse(user);
        if (authority === "write") {
          await writerGate;
          if (!trail.length) delta(response, { name: "write_file", args: { path: "app.py", content: "print('OK')\n" } });
          else delta(response, submit({ summary: "Changed app output" }));
        } else {
          if (!trail.length) delta(response, { name: "read_file", args: { path: "app.py" } });
          else delta(response, submit({ summary: "Current app prints WRONG" }));
        }
      } else if (prompt.includes("Implement in this worktree")) {
        if (useWorkers && !trail.length) delta(response, { name: "start_job", args: { kind: "write", task: "Make app.py output OK" } });
        else if (useWorkers && trail.at(-1) === "start_job") delta(response, { name: "write_file", args: { path: "app.py", content: "print('cannot race')\n" } });
        else if (useWorkers && trail.at(-1) === "write_file") {
          releaseWriter();
          delta(response, submit({ summary: "Delegated update" }));
        } else if (!trail.length) delta(response, { name: "write_file", args: { path: "app.py", content: "print('OK')\n" } });
        else if (!trail.includes("dev_check")) delta(response, { name: "dev_check", args: { id: "simple" } });
        else delta(response, submit({ summary: "Updated app" }));
      } else if (prompt.includes("Independently select")) {
        assert.ok(!user.includes("Delegated update"));
        assert.ok(!user.includes("Update output"));
        assert.deepEqual((JSON.parse(user) as { request: string }).request.includes("note"), true);
        delta(response, submit({ cases: [{ check: "output", scenario: "default" }] }));
      } else throw new Error(`Unexpected prompt: ${prompt.slice(0, 300)}`);
    } catch (error) { failures.push(String(error)); response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { "worq-test": { api: "openai-completions", apiKey: "offline-test", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "test", name: "Test Model", reasoning: false }] } } }));
  await writeFile(join(config, "settings.json"), JSON.stringify({ tuiMode: mode, quietStartup: true }));
  await writeFile(join(cwd, "app.py"), "print('WRONG')\n");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=fixture", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "app.py"); git("commit", "-qm", "baseline");
  await writeFile(profile, JSON.stringify({ version: 1, repository: cwd, trustLocalCode: true, surface: "cli", entry: "app.py", interpreter: "/usr/bin/python3",
    devChecks: [{ id: "simple", executable: "/usr/bin/true", args: [] }],
    checks: [{ id: "output", outcome: "Standard output is exactly OK", scenarios: [{ id: "default", name: "Run app", args: [], expect: [{ channel: "stdout", op: "equals", value: "OK\n" }] }] }] }), { mode: 0o600 });
  const env = { ...cleanEnv, PI_CODING_AGENT_DIR: config, WORQ_PROFILE: profile, WORQ_STATE_DIR: state, HOME: home, TERM: "xterm-256color" };
  const records = async () => Promise.all((await readdir(state)).map(async (name) => JSON.parse(await readFile(join(state, name, "run.json"), "utf8"))));
  return { cwd, env, journal, failures, records, git };
}

test("Pi loads the installed package and /worq runs managed jobs with one writer", { timeout: 30_000 }, async (t) => {
  const h = await harness(t, "fullscreen", true);
  const install = await runProcess(process.execPath, [cli, "install", packagePath], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(5_000), ms: 6000 });
  assert.equal(install.code, 0, install.stderr);
  const request = "Make the note print OK";
  const result = await runProcess(process.execPath, [cli, ...options, "-p", `/worq ${request}`], { cwd: h.cwd, env: h.env, signal: AbortSignal.timeout(20_000), ms: 21_000 });
  assert.deepEqual(h.failures, [], JSON.stringify(h.failures) + result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /PASS · Verify · 1\/1 observed/, `${result.stdout}\n${result.stderr}\n${JSON.stringify(h.journal)}`);
  assert.ok(h.journal.some((entry) => entry.includes("only writer slot")), JSON.stringify(h.journal));
  const [record] = await h.records();
  assert.equal(record.request, request);
  assert.deepEqual(record.jobs.map((job: { kind: string; state: string }) => [job.kind, job.state]), [["read", "done"], ["write", "done"]]);
  assert.equal(h.git("status", "--porcelain"), "");
});

const type = (text: string): Action => ({ type: "type", text });
const press = (key: Extract<Action, { type: "press" }>["key"]): Action => ({ type: "press", key });
const wait = (ms: number): Action => ({ type: "wait", ms });
const observe: Action = { type: "observe" };
for (const mode of ["regular", "fullscreen"] as const) {
  test(`Pi ${mode}: command, clarification, keyboard inspector, resize and editor`, { timeout: 25_000 }, async (t) => {
    const h = await harness(t, mode);
    const screens = await journeyPty(process.execPath, invocation, [
      wait(1400), type("/worq Clarify the note"), press("enter"), wait(800), observe,
      type("/worq answer OK"), press("enter"), wait(1000), type("/worq status"), press("enter"), wait(450), observe,
      press("down"), press("down"), press("down"), press("down"), press("enter"), wait(150), observe,
      press("escape"), wait(150), press("escape"), wait(150), type("unfinished draft"), { type: "resize", cols: 45, rows: 20 }, wait(250), observe,
    ], h.cwd, h.env, AbortSignal.timeout(20_000));
    const text = screens.map((entry) => entry.screen);
    assert.deepEqual(h.failures, []);
    assert.match(text[0], /Which text should the CLI print\?|\/worq answer/);
    assert.match(text[1], /Worq status/);
    assert.match(text[2], /Expected: stdout equals/);
    assert.match(text[3], /unfinished draft/);
    const [record] = await h.records();
    assert.equal(record.state, "pass");
  });
}

test("bare /worq opens an editor; /worq stop joins the run", { timeout: 20_000 }, async (t) => {
  const h = await harness(t);
  const screens = await journeyPty(process.execPath, invocation, [
    wait(1400), type("/worq"), press("enter"), wait(250), observe,
    type("Slow note"), press("enter"), wait(300), observe,
    type("/worq stop"), press("enter"), wait(450), observe,
  ], h.cwd, h.env, AbortSignal.timeout(15_000));
  assert.match(screens[0].screen, /What outcome should Worq deliver\?/);
  assert.match(screens[1].screen, /Capturing the requested outcome/);
  assert.match(screens[2].screen, /CANCELLED|cancelled/);
  const [record] = await h.records();
  assert.equal(record.state, "cancelled");
  assert.equal(h.git("branch", "--list", "worq/*"), "");
});
