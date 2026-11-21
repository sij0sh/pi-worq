import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { processTools, readTools, writeTools } from "../src/tools.ts";

const signal = AbortSignal.timeout(30_000);
const call = async (tools: ReturnType<typeof readTools>, name: string, params: object): Promise<string> => {
  const out = await tools.find((tool) => tool.name === name)!.run(params as never, signal);
  return typeof out === "string" ? out : out.text;
};

test("search: one bounded call finds matches and refuses .git, binaries and stray links", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-search-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n");
  await writeFile(join(root, ".git", "config"), "[core]\nneedle = 1\n");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  await mkdir(join(dir, "outside"));
  await writeFile(join(dir, "outside", "secret.ts"), "needle\n");
  await symlink(join(dir, "outside"), join(root, "link"));
  const tools = readTools(root);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["list_files", "read_file", "search"]);
  const out = await call(tools, "search", { pattern: "needle" });
  assert.match(out, /^src\/a\.ts:1:const needle = 1;$/m);
  assert.doesNotMatch(out, /\.git|blob\.bin|secret/);
});

test("search: results are capped and say so; a bad pattern is a Block", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worq-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "many.txt"), Array.from({ length: 250 }, () => "hit").join("\n"));
  const out = await call(readTools(root), "search", { pattern: "^hit$" });
  assert.equal(out.split("\n").length, 201, "200 hits plus the cap line");
  assert.match(out, /results capped\)$/);
  await assert.rejects(call(readTools(root), "search", { pattern: "(" }), /Invalid regular expression/);
});

test("edit_file names its parameters so a model does not guess", () => {
  const edit = writeTools("/tmp").find((tool) => tool.name === "edit_file")!;
  assert.match(edit.description, /path, old, replacement/);
});

test("process tools: a private short TMPDIR, the interpreter on PATH, and both removed on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worq-box-"));
  try {
    const box = processTools(dir, join(dir, "runtime"), { signal });
    const env = await box.tools.find((tool) => tool.name === "run_command")!.run({ executable: "/usr/bin/env", args: [] } as never, signal) as string;
    const tmp = /^TMPDIR=(.+)$/m.exec(env)![1];
    assert.ok(tmp.startsWith("/tmp/worq-"), tmp);
    assert.ok((await lstat(tmp)).isDirectory());
    assert.match(env, new RegExp(`^PATH=${dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"));
    await box.close();
    await assert.rejects(lstat(tmp), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
