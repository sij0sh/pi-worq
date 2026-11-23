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
  await writeFile(join(root, "sibling.txt"), "needle\n");
  await writeFile(join(root, "src", "b.ts"), "needle\n");
  const search = (path: string) => call(tools, "search", { path, pattern: "needle" });
  assert.equal(await search("src/a.ts"), "src/a.ts:1:const needle = 1;");
  assert.deepEqual((await search("src")).split("\n").sort(), ["src/a.ts:1:const needle = 1;", "src/b.ts:1:needle"]);
  assert.match(await search("blob.bin"), /^No matches/);
  await writeFile(join(root, "large.txt"), "needle".repeat(400_000));
  assert.equal(await search("large.txt"), "No matches in 0 files");
  for (const path of ["link/secret.ts", "../outside/secret.ts", ".git/config"]) {
    await assert.rejects(search(path), /Symbolic link is not allowed|Invalid relative path/);
  }

  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "local.txt"), "needle");
  await symlink(join(dir, "outside"), join(root, "node_modules", "dep"));
  assert.match(await search("."), /secret\.ts:1:needle/);
  assert.equal(await search("node_modules"), "node_modules/local.txt:1:needle");
  await assert.rejects(search("node_modules/dep/secret.ts"), /Symbolic link is not allowed/);
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

test("read_file: limit composes with offset and preserves default and safety caps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worq-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = readTools(root);
  await writeFile(join(root, "rows.txt"), Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join("\n"));
  assert.equal(await call(tools, "read_file", { path: "rows.txt", offset: 4, limit: 2 }), "4: row 4\n5: row 5");
  assert.equal(await call(tools, "read_file", { path: "rows.txt", offset: 200, limit: 2 }), "200: row 200");
  const rows = (await call(tools, "read_file", { path: "rows.txt", offset: 4 })).split("\n");
  assert.equal(rows.length, 160);
  assert.equal(rows.at(-1), "163: row 163");
  await writeFile(join(root, "wide.txt"), "x".repeat(21_000));
  assert.equal((await call(tools, "read_file", { path: "wide.txt", limit: 1 })).length, 20_000);
  await writeFile(join(root, "large.txt"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(call(tools, "read_file", { path: "large.txt", limit: 1 }), /Expected a regular file/);
  await writeFile(join(root, "binary.txt"), "first\n\0");
  await assert.rejects(call(tools, "read_file", { path: "binary.txt", limit: 1 }), /Binary files/);
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
