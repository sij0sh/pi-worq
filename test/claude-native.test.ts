import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Block, obj, text } from "../src/contracts.ts";
import { AGENT_IDENTITY, BILLING_HEADER, claudeAdapter, loadRealSdk, managedFilesProblem } from "../src/sdk/claude.ts";
import type { Driver, Runtime, SessionSpec, Tool } from "../src/sdk/contract.ts";
import { Conversation } from "../src/session.ts";
import { Telemetry } from "../src/telemetry.ts";

const runtime: Runtime = { name: "launch", sdk: "claude-code", model: "claude-sonnet-4-5", via: "fixture", path: "" };
const system = "This is the exact Worq system prompt.";
const key = "sk-ant-test-worq-not-a-real-key";
const secret = "WORQ_AMBIENT_FIXTURE_CANARY";
const value = obj({ value: text(20) });
const tool = (name: string, input: object, index: number) => ({ type: "tool_use", id: `toolu_Worq${index}`, name: `mcp__worq__${name}`, input });
type ToolCall = ReturnType<typeof tool>;
interface WireRequest {
  model: string;
  tools: { name: string; input_schema: { type: string; properties?: object; required?: string[]; additionalProperties?: boolean } }[];
  system: { type: string; text: string }[];
  messages: { role: string; content: { type: string; text?: string; tool_use_id?: string; content?: { type: string; text?: string }[] }[] }[];
}

function assertFirstPrompt(request: WireRequest, cwd: string) {
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  const content = request.messages[0].content;
  assert.equal(content.length, 4);
  assert.ok(content.every(({ type }) => type === "text"));
  const lines = content[0].text?.split("\n") ?? [];
  assert.deepEqual(lines.slice(0, 5), ["<system-reminder>", "# Environment", "You have been invoked in the following environment: ",
    ` - Primary working directory: ${cwd}`, " - Is a git repository: true"]);
  assert.match(lines[5], /^ - Platform: (linux|darwin|win32)$/);
  assert.match(lines[6], /^ - Shell: [\w. -]+$/);
  assert.match(lines[7], /^ - OS Version: [\w. ()-]+$/);
  const tail = [
    " - Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.",
    " - In `curl`, send untrusted values with `--form-string`, not `-F`.", "</system-reminder>",
  ];
  assert.deepEqual(lines.slice(8), tail);
  assert.equal(content[1].text, "<system-reminder>\nYou are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5. Assistant knowledge cutoff is January 2025.\n</system-reminder>");
  assert.match(content[2].text ?? "", /^<system-reminder>\nToday's date is \d{4}-\d{2}-\d{2}\.\n<\/system-reminder>\n?$/);
  assert.equal(content[3].text, "Worq user prompt.");
}

async function poisoned(root: string, sentinel: string) {
  const dir = join(root, ".claude");
  await mkdir(join(dir, "agents"), { recursive: true });
  await mkdir(join(dir, "skills", "poison"), { recursive: true });
  const put = async (path: string, data: string) => writeFile(path, data);
  const command = `echo ${secret} > "${sentinel}"`;
  const hook = { hooks: [{ type: "command", command }] };
  await Promise.all([
    put(join(root, "CLAUDE.md"), secret), put(join(dir, "CLAUDE.md"), secret), put(join(root, "AGENTS.md"), secret),
    put(join(dir, "agents", "Explore.md"), `---\nname: Explore\ndescription: ${secret}\n---\n${secret}\n`),
    put(join(dir, "skills", "poison", "SKILL.md"), `---\nname: poison\ndescription: ${secret}\n---\n${secret}\n`),
    put(join(dir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [hook], UserPromptSubmit: [hook] } })),
    put(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { poison: { command: "sh", args: ["-c", command] } } })),
  ]);
}

test("Claude SDK 0.3.332: native conversation, loopback-only provider", { timeout: 45_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worq-claude-")));
  const cwd = join(root, "checkout"), home = join(root, "home"), managed = join(root, "policy");
  const sentinel = join(root, "executed");
  await mkdir(managed);
  await poisoned(cwd, sentinel);
  await poisoned(home, sentinel);
  execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet", cwd], { env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
  const originalHome = process.env.HOME;
  process.env.HOME = home; // settings resolver is local; spawn gets its own explicit environment below.
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
  const requests: WireRequest[] = [];
  const unexpected: string[] = [];
  let respond = (_request: WireRequest, _index: number): ToolCall[] => [];
  let httpError: number | undefined;
  let wireID = 0;
  const recorder = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages" || req.headers["x-api-key"] !== key) {
        unexpected.push(`${req.method} ${req.url}`); res.writeHead(404).end(); return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const request: WireRequest = JSON.parse(body);
      requests.push(request);
      if (httpError) {
        res.writeHead(httpError, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: httpError === 429 ? "rate_limit_error" : "invalid_request_error", message: "local fixture refusal" } }));
        return;
      }
      const calls = respond(request, requests.length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      event("message_start", { message: { id: `msg_Worq${++wireID}`, type: "message", role: "assistant", content: [], model: request.model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 1 } } });
      calls.forEach(({ input, ...call }, index) => {
        event("content_block_start", { index, content_block: { ...call, input: {} } });
        event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        event("content_block_stop", { index });
      });
      await sleep(20);
      event("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
      event("message_stop"); res.end();
    } catch { unexpected.push("invalid provider request"); res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
  const addr = recorder.address();
  assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}`;
  const exits: { waited: Promise<void>; kill(): void }[] = [];
  let onSpawn: (() => void) | undefined;
  t.after(async () => {
    for (const process of exits) process.kill();
    await Promise.all(exits.map((child) => child.waited));
    recorder.closeAllConnections();
    await new Promise<void>((resolve) => recorder.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const sdk = await loadRealSdk(({ command, args, cwd: childCwd, env, signal }) => {
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
    assert.equal(env.ENABLE_TOOL_SEARCH, "false");
    const child = spawn(command, args, { cwd: childCwd, signal, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: env.PATH, SystemRoot: env.SystemRoot, ComSpec: env.ComSpec, HOME: home, USERPROFILE: home,
      APPDATA: home, LOCALAPPDATA: home, TMPDIR: root,
      CLAUDE_CODE_MANAGED_SETTINGS_PATH: managed,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      CLAUDE_CODE_MAX_RETRIES: env.CLAUDE_CODE_MAX_RETRIES,
      DISABLE_TELEMETRY: env.DISABLE_TELEMETRY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      ENABLE_TOOL_SEARCH: env.ENABLE_TOOL_SEARCH, CLAUDE_CODE_ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT,
      ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: url,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1",
    } });
    child.stderr.resume();
    // SDK consumes stdout; explicit process observation also covers failed open and catalog disposal.
    const waited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    exits.push({ waited, kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } });
    if (onSpawn) queueMicrotask(onSpawn);
    return child;
  });
  async function exited() {
    await Promise.race([exits.at(-1)!.waited, sleep(4500, undefined, { ref: false }).then(() => assert.fail("Claude worker did not exit"))]);
  }
  const adapter = claudeAdapter({}, sdk);
  let executed = 0;
  const tools: Tool[] = [
    { name: "echo", description: "Echo.", parameters: value, run: ({ value }) => { executed++; return `echo:${value}`; } },
    { name: "boom", description: "Throw.", parameters: obj({}), run: () => { executed++; throw new Block("boom", "fixture tool failed"); } },
  ];
  function conversation(turns: number, { signal = new AbortController().signal, minutes = 1 } = {}) {
    const logs: string[] = [];
    const telemetry = new Telemetry();
    telemetry.add("x", "x", "x");
    const admissions: number[] = [];
    const driver: Driver = {
      capabilities: () => adapter.capabilities(runtime),
      async open(spec) {
        const handle = await adapter.open({ ...spec, runtime, admitRequest: async (signal) => {
          admissions.push(requests.length);
          return spec.admitRequest!(signal);
        } });
        return handle;
      },
    };
    return { c: new Conversation({ driver, signal, turns, minutes, finish: { description: "Finish.", schema: value },
      spec: { name: "x", cwd, system, tools, log: (line) => logs.push(line), observe: telemetry.sink("x") } }), logs, admissions, row: telemetry.rows.get("x")! };
  }
  const openSpec = (signal: AbortSignal): SessionSpec => ({ id: "direct", name: "direct", cwd, runtime, system, tools, signal, emit() {} });
  await t.test("empty input readiness, catalog and isolated managed file detection", async () => {
    const versionFile = join(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))), "package.json");
    const { version } = JSON.parse(await readFile(versionFile, "utf8"));
    assert.equal(version, "0.3.332");
    const bare = await adapter.open(openSpec(new AbortController().signal));
    assert.equal(requests.length, 0);
    assert.equal(bare.selection?.model, runtime.model);
    await bare.configure!({ model: "claude-fable-5-2[1m]" });
    assert.equal(bare.selection?.model, "claude-fable-5-2[1m]");
    bare.dispose(); await exited();
    const catalog = await adapter.models();
    assert.ok(catalog.some((ref) => /^claude-/.test(ref)), catalog.join(", "));
    assert.equal(requests.length, 0);
    await exited();
    for (const file of ["managed-mcp.json", "CLAUDE.md"]) {
      const path = join(managed, file);
      await writeFile(path, secret);
      assert.equal(await managedFilesProblem(managed), `machine policy provides ${file}`);
      await rm(path);
    }
  });
  await t.test("real MCP echo and submit, no further send or sibling after submit", async () => {
    const before = requests.length;
    respond = (_, index) => index === before + 1 ? [tool("echo", { value: "hello" }, 1)]
      : [tool("submit", { value: "done" }, 2), tool("echo", { value: "too late" }, 3)];
    const { c, row, admissions, logs } = conversation(2);
    try {
      assert.deepEqual(await c.run("Worq user prompt."), { value: "done" });
      assert.deepEqual(admissions, [before, before + 1]);
      assert.equal(requests.length, before + 2);
      assert.equal(executed, 1, logs.join("\n"));
      const [first, second] = requests.slice(before);
      assert.equal(first.model, runtime.model);
      assert.deepEqual(first.tools.map((entry) => entry.name).sort(), ["mcp__worq__boom", "mcp__worq__echo", "mcp__worq__submit"]);
      const schema = first.tools.find((entry) => entry.name === "mcp__worq__echo")!.input_schema;
      assert.deepEqual(schema.properties, { value: { type: "string", minLength: 1, maxLength: 20 } });
      assert.deepEqual(schema.required, ["value"]);
      assert.equal(schema.additionalProperties, false);
      assert.ok(BILLING_HEADER.test(first.system[0].text));
      assert.deepEqual(first.system.slice(1).map((block) => block.text), [AGENT_IDENTITY, system]);
      assertFirstPrompt(first, cwd);
      assertFirstPrompt({ ...second, messages: second.messages.slice(0, 1) }, cwd);
      assert.deepEqual(second.messages.slice(1, 2), [{ role: "assistant", content: [tool("echo", { value: "hello" }, 1)] }]);
      assert.equal(second.messages.length, 3);
      assert.equal(second.messages[2].role, "user");
      const [returned] = second.messages[2].content;
      assert.equal(second.messages[2].content.length, 1);
      assert.equal(returned.type, "tool_result");
      assert.equal(returned.tool_use_id, "toolu_Worq1");
      assert.deepEqual(returned.content?.[0], { type: "text", text: "echo:hello\n" });
      assert.equal(returned.content?.length, 2);
      assert.match(returned.content?.[1].text ?? "", /^<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>$/);
      assert.equal(JSON.stringify([first, second]).includes(secret), false);
      assert.equal(existsSync(sentinel), false);
      assert.equal(row.setup?.model, runtime.model);
      assert.equal(row.turns, 2);
      assert.deepEqual(row.cache, { responses: 2, read: 6, write: 4, reads: 2, writes: 2 });
      assert.ok((row.speed ?? 0) > 0);
    } finally { c.dispose(); await exited(); }
    assert.equal(requests.length, before + 2);
  });
  await t.test("refuses successful, invalid and thrown-tool continuations; budget stop is reusable", async () => {
    for (const calls of [[tool("echo", { value: "yes" }, 10)], [tool("echo", {}, 11), tool("echo", { value: "yes", extra: true }, 12)], [tool("boom", {}, 13)], [tool("missing", {}, 15)]]) {
      const before = requests.length, ran = executed;
      respond = (_, index) => index === before + 1 ? calls : [tool("submit", { value: "fresh" }, 14)];
      const { c, admissions } = conversation(1);
      try {
        await assert.rejects(c.run("Do not continue."), (error: unknown) => error instanceof Block && error.code === "turn-limit");
        assert.deepEqual(admissions, [before, before + 1]);
        assert.equal(requests.length, before + 1);
        assert.equal(executed - ran, calls.length === 2 || calls[0].name.endsWith("__missing") ? 0 : 1);
        assert.deepEqual(await c.run("Fresh budget."), { value: "fresh" });
        assert.equal(requests.length, before + 2);
      } finally { c.dispose(); await exited(); }
    }
  });
  await t.test("awaits a model change at the continuation boundary", async () => {
    const before = requests.length, admissions: number[] = [];
    let switcher: (() => Promise<void>) | undefined;
    respond = (_, index) => index === before + 1 ? [tool("echo", { value: "next model" }, 40)] : [tool("submit", { value: "switched" }, 41)];
    const signal = new AbortController().signal;
    const driver: Driver = {
      capabilities: () => adapter.capabilities(runtime),
      async open(spec) {
        const handle = await adapter.open({ ...spec, runtime: { ...runtime, model: "opus" }, admitRequest: async (gateSignal) => {
          admissions.push(requests.length);
          if (admissions.length === 2) await switcher!();
          return spec.admitRequest!(gateSignal);
        } });
        switcher = () => handle.configure!({ model: "claude-haiku-4-5" });
        return handle;
      },
    };
    const c = new Conversation({ driver, signal, turns: 2, minutes: 1, finish: { description: "Finish.", schema: value },
      spec: { name: "switch", cwd, system, tools, log() {} } });
    try {
      assert.deepEqual(await c.run("Change the model before continuing."), { value: "switched" });
      assert.deepEqual(admissions, [before, before + 1]);
      assert.match(requests[before].model, /^claude-opus-\d/);
      assert.equal(requests[before + 1].model, "claude-haiku-4-5");
    } finally { c.dispose(); await exited(); }
    assert.equal(requests.length, before + 2);
  });
  await t.test("timeout and caller cancellation while awaiting a continuation release no send", async () => {
    for (const reason of ["time-limit", "cancelled"]) {
      const before = requests.length;
      const controller = new AbortController();
      respond = () => [tool("echo", { value: "wait" }, 50)];
      let attempted = 0;
      const driver: Driver = {
        capabilities: () => adapter.capabilities(runtime),
        open: (spec) => adapter.open({ ...spec, runtime, admitRequest: async (gateSignal) => {
          if (++attempted === 1) return spec.admitRequest!(gateSignal);
          if (reason === "cancelled") queueMicrotask(() => controller.abort(new Block("cancelled", "fixture cancellation")));
          return new Promise(() => {}); // Neither timeout nor cancellation may fail open if an admission stalls.
        } }),
      };
      const c = new Conversation({ driver, signal: controller.signal, turns: 2, minutes: reason === "time-limit" ? 0.035 : 1,
        finish: { description: "Finish.", schema: value }, spec: { name: "stop", cwd, system, tools, log() {} } });
      try {
        await assert.rejects(c.run("Wait for admission."), (error: unknown) => error instanceof Block && error.code === reason);
        assert.equal(attempted, 2);
        assert.equal(requests.length, before + 1);
      } finally { c.dispose(); await exited(); }
      assert.equal(requests.length, before + 1);
    }
  });
  await t.test("failed and cancelled native opens reap their workers", async () => {
    const before = requests.length;
    const mismatch = { ...openSpec(new AbortController().signal), runtime: { ...runtime, model: "claude-haiku-4-5[1m]" } };
    await assert.rejects(adapter.open(mismatch), /could not verify the selected model/);
    await exited();
    assert.equal(requests.length, before);
    const controller = new AbortController();
    onSpawn = () => controller.abort(new Error(secret));
    try { await assert.rejects(adapter.open(openSpec(controller.signal)), /Claude open cancelled/); }
    finally { onSpawn = undefined; }
    await exited();
    assert.equal(requests.length, before);
  });
  await t.test("pinned HTTP fallback stays inside one admitted generation", async () => {
    for (const [status, sends] of [[429, 1], [400, 3]]) {
      const before = requests.length;
      httpError = status;
      const { c, admissions } = conversation(2);
      try {
        await assert.rejects(c.run("Provider failure."), /request failed/);
        assert.deepEqual(admissions, [before]);
        assert.equal(requests.length - before, sends);
        assert.ok(requests.slice(before).every((request) => request.model === runtime.model));
      } finally { httpError = undefined; c.dispose(); await exited(); }
    }
  });
  assert.deepEqual(unexpected, []);
});
