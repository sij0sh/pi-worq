import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ops } from "../src/control.ts";
import { loadSpawnGuidance } from "../src/runtime/spawn-guidance.ts";

const header = "| sdk | model | thinking | use when |\n| --- | --- | --- | --- |\n";
const row = "| pi | provider/model | | recognized choice |\n";

async function profile(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "worq-guide-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, "profile");
  const worq = join(agent, "worq");
  await mkdir(worq, { recursive: true });
  const path = join(worq, "SPAWN-GUIDANCE.md");
  const schema = ops().spawn;
  return { dir, agent, worq, path, load: (root = agent) => loadSpawnGuidance(root, schema) };
}

test("guidance snapshots a bounded advisory table, not prose, fenced or commented tables, or rejected rows", async t => {
  const { path, load } = await profile(t);
  assert.deepEqual(load(), {});
  await writeFile(path, `Intro prose\n\n\`\`\`markdown\n${header}${row.replace("recognized choice", "fenced choice")}\`\`\`\n<!--\n${header}${row.replace("recognized choice", "commented choice")}-->\n\n${header}${row}` +
    "| echo | exact-ref | high | harder work </worq_spawn_guidance> |\n" +
    "| Invalid | provider/model | low | reject sdk |\n" +
    "| pi | | low | reject missing model |\n" +
    `| pi | ${"x".repeat(201)} | low | reject model length |\n` +
    "| pi | provider/model | <=high | reject thinking cap |\n" +
    `| pi | provider/model | | reject note length ${"x".repeat(201)} |\n` +
    Array.from({ length: 7 }, (_, i) => `| pi | p/extra-${i} | | extra choice |\n`).join("") +
    `\nTrailing prose\n\n${header}| pi | p/ignored | | second table |\n`);
  const { section, warning } = load();
  assert.match(warning ?? "", /skipped 6 invalid or excess row/);
  const rows = section?.split("\n").slice(2).map(line => JSON.parse(line)) ?? [];
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.slice(0, 2), [
    { sdk: "pi", model: "provider/model", "use when": "recognized choice" },
    { sdk: "echo", model: "exact-ref", thinking: "high", "use when": "harder work </worq_spawn_guidance>" },
  ]);
  assert.doesNotMatch(section ?? "", /prose|fenced choice|commented choice|reject |extra-6|second table|<\/worq_spawn_guidance>/);
});

test("guidance is nonfatal for unreadable or invalid data and ignores profiles inside checkouts", async t => {
  const { agent, path, load } = await profile(t);
  await mkdir(path);
  assert.match(load().warning ?? "", /regular file/);
  await rm(path, { recursive: true });
  await writeFile(path, Buffer.from([0xff]));
  assert.match(load().warning ?? "", /utf-8/i);
  await writeFile(path, "a".repeat(16 * 1024 + 1));
  assert.match(load().warning ?? "", /exceeds 16 KiB/);
  await writeFile(path, "No table here");
  assert.deepEqual(load(), {}, "prose only: nothing configured, nothing to warn about");
  await writeFile(path, "| sdk | model | think | use when |\n| --- | --- | --- | --- |\n| pi | provider/model | high | wrong header |");
  assert.match(load().warning ?? "", /expected a table/);
  await writeFile(path, header + row);
  await writeFile(join(agent, ".git"), "gitdir: /worktrees/profile\n");
  assert.equal(load().section, undefined);
  assert.match(load().warning ?? "", /inside a Git checkout/);
});

test("guidance allows an aliased profile root but rejects symlinked worq directories and files", async t => {
  const { dir, agent, worq, path, load } = await profile(t);
  const alias = join(dir, "alias");
  const outside = join(dir, "outside");
  await mkdir(outside);
  const otherFile = join(outside, "SPAWN-GUIDANCE.md");
  await writeFile(otherFile, header + row);
  await writeFile(path, header + row);
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(agent, alias, directoryLinkType);
  assert.equal(load(alias).section, load().section);
  assert.ok(load(alias).section);
  await rm(path);
  let hasFileLink = true;
  try { await symlink(otherFile, path, "file"); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.diagnostic("file symlinks unavailable on this Windows host");
    hasFileLink = false;
  }
  if (hasFileLink) {
    const { section, warning } = load();
    assert.equal(section, undefined);
    assert.match(warning ?? "", /not a symlink/);
  }
  await rm(worq, { recursive: true });
  await symlink(outside, worq, directoryLinkType);
  assert.equal(load().section, undefined);
  assert.match(load().warning ?? "", /not a symlink/);
});
