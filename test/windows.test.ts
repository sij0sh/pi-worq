import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { serve } from "../src/control.ts";
import { windows } from "../src/platform.mjs";
import { cleanEnv, launch, runProcess } from "../src/process.ts";
import { processTools } from "../src/tools.ts";
import { scoped } from "../src/workspace.ts";

const opts = { skip: !windows && "Windows only" };
const run = { cwd: process.cwd(), env: cleanEnv, ms: 10_000, signal: AbortSignal.timeout(30_000) };
const waitForExit = async (pid: number) => {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await sleep(20);
  }
  assert.fail(`Descendant ${pid} still running`);
};

test("Windows job kills detached descendants on exit and abort", opts, async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    let output = "";
    const child = launch(process.execPath, ["-e", `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'],
        { detached: true, stdio: 'ignore', windowsHide: true });
      console.log(child.pid);
      child.unref();
      if (${abort}) setInterval(()=>{}, 1000);
    `], { ...run, signal: controller.signal, stdout: chunk => {
      output += chunk.toString();
      if (abort && output.includes("\n")) controller.abort();
    } });
    if (abort) await assert.rejects(child.done, { name: "AbortError" });
    else assert.equal((await child.done).code, 0);
    const pid = Number(output.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, output);
    await waitForExit(pid);
  }
});

test("Windows command bridge preserves argv/stdin/exit and refuses batch shims", opts, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "worq with spaces & symbols-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const args = ["a b", "a\"b", "a b\\", "a&b", "", "λ"];
  const result = await runProcess("node", ["-e", `
    process.stdout.write(JSON.stringify(process.argv.slice(1)));
    process.stdin.pipe(process.stderr);
    process.exitCode = 7;
  `, "--", ...args], { ...run, cwd, stdin: "from caller\n" });
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(result.stderr, "from caller\n");
  assert.equal(result.code, 7);
  const shim = join(cwd, "shim.cmd");
  await writeFile(shim, "@echo unexpected\r\n");
  await assert.rejects(runProcess(shim, [], { ...run, cwd }), { code: "launch" });
});

test("Windows file tools reject alternate path syntax; artifact saving works without PTY", opts, async t => {
  const dir = await mkdtemp(join(tmpdir(), "worq-scoped-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["src\\..\\.git\\config", ".git./config", "Git~1/config", ".. ", "z:relative", "file.txt:stream", "NUL.txt", "LPT¹", "x\u0001y"]) {
    await assert.rejects(scoped(dir, path, { missing: true }), { code: "path" }, path);
  }
  const artifacts = join(dir, "artifacts");
  await writeFile(join(dir, "report.txt"), "evidence");
  const box = processTools(dir, join(dir, "runtime"), { signal: run.signal, verify: { artifacts, services: 1 } });
  try {
    assert.ok(!box.tools.some(tool => tool.name === "observe_terminal"));
    const save = box.tools.find(tool => tool.name === "save_artifact")!;
    assert.match(String(await save.run({ path: "report.txt" }, run.signal)), /Saved /);
    assert.equal(await readFile(join(artifacts, "report.txt"), "utf8"), "evidence");
  } finally { await box.close(); }
});

test("Windows control CLI discovers the pipe; unauthenticated requests cannot dispatch", opts, async t => {
  const state = await mkdtemp(join(tmpdir(), "worq pipe-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const handled: string[] = [];
  const server = await serve(state, async op => { handled.push(op); return { text: "ok" }; });
  try {
    const raw = connect(server.path);
    const closed = once(raw, "close");
    raw.on("connect", () => raw.write('{"op":"cancel","args":{"ref":"all"}}\n'));
    await closed;
    assert.deepEqual(handled, []);
    const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath,
      [join(import.meta.dirname, "..", "bin", "worq.mjs"), ...args],
      { env: { ...process.env, WORQ_STATE_DIR: state }, timeout: 5000 })).stdout.trim();
    assert.equal(await cli("sessions"), `pi ${process.pid}`);
    assert.equal(await cli("list", "--pid", String(process.pid)), "ok");
    assert.deepEqual(handled, ["list"]);
  } finally { await server.close(); }
  await assert.rejects(lstat(join(state, "ctl", `${process.pid}.json`)), { code: "ENOENT" });
});
