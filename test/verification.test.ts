import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { repo } from "./fake.ts";

test("documented exact-diff check passes the expected edit and rejects plausible wrong candidates", async (t) => {
  const { dir, root, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(root, "app.py");
  const expected = join(dir, "expected.patch");
  const script = join(import.meta.dirname, "..", "docs", "examples", "check-exact-diff.sh");
  const correct = "print('HELLO')\n";
  const check = () => {
    const result = spawnSync("bash", [script, expected], { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result.status;
  };
  await writeFile(file, correct);
  await writeFile(expected, git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--"));
  assert.equal(check(), 0);
  for (const wrong of ["print('hello')\n", "print('HELLO!')\n", "print('HELLO')", `${correct}print('extra')\n`]) {
    await writeFile(file, wrong);
    assert.equal(check(), 1, JSON.stringify(wrong));
  }
  await writeFile(file, correct);
  await writeFile(join(root, "extra.txt"), "unexpected");
  assert.equal(check(), 1, "untracked extra file");
  await rm(join(root, "extra.txt"));
  await writeFile(join(root, ".gitignore"), "*\n");
  assert.equal(check(), 1, "extra tracked edit");
  git("restore", ".gitignore");
  git("add", "app.py");
  assert.equal(check(), 1, "unexpected staged change");
});
