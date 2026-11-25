import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { runGates, type GateSpec } from "../src/gate.ts";
import { cleanEnv, runProcess } from "../src/process.ts";
import { runtimeEnv } from "../src/workspace.ts";

const win = process.platform === "win32";
async function scratch(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "worq-gates-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const node = (name: string, code: string, independent?: boolean): GateSpec => ({
  name, executable: process.execPath, args: ["-e", code], independent,
});

test("gate preflight checks later executables before the first side effect", async (t) => {
  const cwd = await scratch(t);
  await writeFile(join(cwd, win ? "bad.cmd" : "bad"), "not executable");
  const first = node("first", `require('node:fs').writeFileSync('first-ran', '')`);
  for (const executable of ["worq-missing-program", win ? ".\\bad.cmd" : "./bad"]) {
    await assert.rejects(runGates(cwd, cleanEnv, [first, { name: "second", executable, args: [] }], AbortSignal.timeout(5000)), /second.*executable.*unavailable/);
    await assert.rejects(realpath(join(cwd, "first-ran")), { code: "ENOENT" });
  }
});

test("gate preflight and launch preserve symlink/.. for explicit executable paths", { skip: win }, async (t) => {
  const cwd = await scratch(t);
  await mkdir(join(cwd, "nested", "deeper"), { recursive: true });
  await symlink("nested/deeper", join(cwd, "link"));
  await writeFile(join(cwd, "probe"), "#!/bin/sh\nexit 9\n", { mode: 0o700 });
  await writeFile(join(cwd, "nested", "probe"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const signal = AbortSignal.timeout(5000);
  for (const executable of ["./link/../probe", `${cwd}/link/../probe`]) {
    const gate = { executable, args: [] };
    assert.equal((await runProcess(executable, [], { cwd, env: cleanEnv, signal, ms: 5000 })).code, 0);
    assert.equal((await runGates(cwd, cleanEnv, [gate], signal))[0].passed, true);
  }
});

test("only contiguous independent gates overlap and results stay ordered", async (t) => {
  const cwd = await scratch(t);
  const fs = `const fs = require('node:fs'); `;
  const gates = [
    node("first", fs + `fs.writeFileSync('first', '')`),
    node("left", fs + `if (!fs.existsSync('first')) process.exit(1); const timer = setInterval(() => { if (fs.existsSync('right')) clearInterval(timer); }, 10);`, true),
    node("right", fs + `if (!fs.existsSync('first') || fs.existsSync('last')) process.exit(1); fs.writeFileSync('right', '')`, true),
    node("last", fs + `if (!fs.existsSync('right')) process.exit(1); fs.writeFileSync('last', '')`),
  ];
  const results = await runGates(cwd, cleanEnv, gates, AbortSignal.timeout(10_000));
  assert.deepEqual(results.map((g) => g.name), gates.map((g) => g.name));
});

test("a failed overlapping gate drains its live sibling and prevents the next batch", async (t) => {
  const cwd = await scratch(t);
  let pid = 0;
  const gates = [
    node("linger", `require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 100);`, true),
    node("fail", `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync('pid')) process.exit(7); }, 10);`, true),
    node("forbidden", `require('node:fs').writeFileSync('forbidden', '')`),
  ];
  await assert.rejects(runGates(cwd, cleanEnv, gates, AbortSignal.timeout(10_000)), /"fail" failed \(exit 7\)/);
  const { readFile } = await import("node:fs/promises");
  pid = Number(await readFile(join(cwd, "pid"), "utf8"));
  // The Windows launcher drains the Job owner; the OS may still be finalizing the child exit.
  if (!win) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(realpath(join(cwd, "forbidden")), { code: "ENOENT" });
});

test("command PATH appends filtered host bins without changing the internal Git environment", async (t) => {
  const dir = await scratch(t);
  const userBin = join(dir, "user-bin");
  const checkout = join(dir, "checkout");
  const checkoutBin = join(checkout, "bin");
  const alias = join(dir, "alias");
  await mkdir(userBin);
  await mkdir(checkoutBin, { recursive: true });
  await symlink(checkoutBin, alias, win ? "junction" : "dir");
  const bin = `worq-host-tool${win ? ".exe" : ""}`;
  if (win) await copyFile(process.execPath, join(userBin, bin));
  else await writeFile(join(userBin, bin), "#!/bin/sh\nprintf host-bin", { mode: 0o700 });
  const strict = cleanEnv.PATH;
  const oldPath = process.env.PATH;
  const oldVenv = process.env.VIRTUAL_ENV;
  process.env.PATH = ["", ".", "relative-bin", userBin, userBin, checkoutBin, alias, join(dir, "missing")].join(delimiter);
  process.env.VIRTUAL_ENV = join(dir, "venv");
  try {
    const { env, tmp } = await runtimeEnv(join(dir, "runtime"), [checkout]);
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const actual = await realpath(userBin);
    assert.deepEqual(env.PATH?.split(delimiter), [...new Set(strict?.split(delimiter)), actual]);
    assert.equal(env.VIRTUAL_ENV, process.env.VIRTUAL_ENV);
    assert.equal(cleanEnv.PATH, strict);
    const signal = AbortSignal.timeout(5000);
    const args = win ? ["-p", "'host-bin'"] : [];
    assert.equal((await runProcess("worq-host-tool", args, { cwd: checkout, env, signal, ms: 5000 })).stdout.trim(), "host-bin");
    assert.equal((await runGates(checkout, env, [{ executable: "worq-host-tool", args }], signal))[0].passed, true);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldVenv === undefined) delete process.env.VIRTUAL_ENV; else process.env.VIRTUAL_ENV = oldVenv;
  }
});
