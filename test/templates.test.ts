import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ops } from "../src/control.ts";
import { loadResources } from "../src/runtime/resources.ts";
import { routingLoader } from "../src/runtime/routing.ts";
import { loadSpawnGuidance } from "../src/runtime/spawn-guidance.ts";
import { provisionTemplates, TEMPLATES, TEMPLATE_SEEDS } from "../src/runtime/templates.ts";

const FILES = ["AGENTS.md", "SPAWN-GUIDANCE.md", "routing.json", "ROUTING.md"];
const seed = (name: string) => readFileSync(join(TEMPLATE_SEEDS, name), "utf8");

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "worq-templates-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("resource templates: a cold profile gets exactly the three operator files, byte-identical to the shipped templates", async t => {
  const dir = await scratch(t);
  const agent = join(dir, "agent");
  assert.deepEqual(TEMPLATES, FILES);
  const { problems } = provisionTemplates(agent);
  assert.deepEqual(problems, []);
  const worq = join(agent, "worq");
  assert.ok(lstatSync(worq).isDirectory());
  assert.deepEqual(readdirSync(worq).sort(), [...FILES].sort());
  for (const name of FILES) assert.equal(readFileSync(join(worq, name), "utf8"), seed(name));
});

test("resource templates are inert: no instructions, no hint rows, no guidance rows, no ignored resource", async t => {
  const dir = await scratch(t);
  const agent = join(dir, "agent");
  assert.deepEqual(provisionTemplates(agent).problems, []);
  const worq = join(agent, "worq");

  // AGENTS.md is one HTML comment: context that names itself, never an instruction.
  const agents = readFileSync(join(worq, "AGENTS.md"), "utf8").trim();
  assert.match(agents, /^<!--[\s\S]*-->$/);
  assert.match(agents, /context, not authority/);

  // Spawn guidance: the only table is commented out, so the parser reports nothing at all.
  assert.deepEqual(loadSpawnGuidance(agent, ops().spawn), {});

  // Routing config: valid JSON with zero roles and zero problems.
  const routing = routingLoader(agent)();
  assert.deepEqual(routing.problems, []);
  assert.deepEqual(routing.config?.roles, {});

  // Shared resources: the comment reaches the prompt as text, and nothing else changes.
  const resources = await loadResources(agent);
  assert.equal(resources.skills.length, 0);
  assert.deepEqual(resources.ignored, []);
  assert.equal(resources.agents, agents);
});

test("resource templates: a later load never overwrites operator edits, existing entries of any kind are skipped, and a deleted file returns", async t => {
  const dir = await scratch(t);
  const agent = join(dir, "agent");
  const worq = join(agent, "worq");
  assert.deepEqual(provisionTemplates(agent).problems, []);

  const edited = "Only report facts you read from the repository.\n";
  await writeFile(join(worq, "AGENTS.md"), edited);
  await rm(join(worq, "SPAWN-GUIDANCE.md"));
  assert.deepEqual(provisionTemplates(agent).problems, []);
  assert.equal(readFileSync(join(worq, "AGENTS.md"), "utf8"), edited, "an operator edit is never replaced");
  assert.equal(readFileSync(join(worq, "SPAWN-GUIDANCE.md"), "utf8"), seed("SPAWN-GUIDANCE.md"), "a deleted file is recreated, per file");

  await rm(join(worq, "routing.json"));
  await mkdir(join(worq, "routing.json"));
  assert.deepEqual(provisionTemplates(agent).problems, [], "a directory in the way is skipped, not replaced");
  assert.ok(lstatSync(join(worq, "routing.json")).isDirectory());
  assert.deepEqual(readdirSync(join(worq, "routing.json")), []);
});

test("resource templates: a symlinked file or worq directory is reported and never followed", async t => {
  const dir = await scratch(t);
  const outside = join(dir, "outside");
  await mkdir(outside);
  const sentinel = join(outside, "AGENTS.md");
  await writeFile(sentinel, "Outside instructions\n");

  const agent = join(dir, "agent");
  await mkdir(join(agent, "worq"), { recursive: true });
  let hasFileLink = true;
  try { await symlink(sentinel, join(agent, "worq", "AGENTS.md"), "file"); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.diagnostic("file symlinks unavailable on this Windows host");
    hasFileLink = false;
  }
  const { problems } = provisionTemplates(agent);
  if (hasFileLink) {
    assert.match(problems.find((problem) => problem.path === join(agent, "worq", "AGENTS.md"))?.message ?? "", /symlink/);
    assert.equal(readFileSync(sentinel, "utf8"), "Outside instructions\n", "the link target is untouched");
    assert.equal(readFileSync(join(agent, "worq", "routing.json"), "utf8"), seed("routing.json"), "an unlinked sibling is still installed");
  } else {
    assert.deepEqual(problems, []);
  }

  const target = join(dir, "target");
  await mkdir(target);
  const linked = join(dir, "linked");
  await mkdir(linked);
  await symlink(target, join(linked, "worq"), process.platform === "win32" ? "junction" : "dir");
  const second = provisionTemplates(linked);
  assert.equal(second.problems.length, 1);
  assert.equal(second.problems[0].path, join(linked, "worq"));
  assert.match(second.problems[0].message, /symlink[\s\S]*by hand, or copy /);
  assert.deepEqual(readdirSync(target), [], "nothing is written through a symlinked directory");
});

test("resource templates: a profile inside a Git checkout is refused before anything is created", async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, ".git"));
  const agent = join(dir, "agent");
  const { problems } = provisionTemplates(agent);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, join(agent, "worq"));
  assert.match(problems[0].message, /inside a Git checkout[\s\S]*by hand, or copy /);
  assert.equal(existsSync(agent), false, "not even the profile directory is created");
});

test("resource templates: a missing agentDir (and its parent) is created recursively", async t => {
  const dir = await scratch(t);
  const agent = join(dir, "deep", "profile");
  assert.deepEqual(provisionTemplates(agent).problems, []);
  assert.ok(lstatSync(join(agent, "worq")).isDirectory());
  assert.deepEqual(readdirSync(join(agent, "worq")).sort(), [...FILES].sort());
  assert.deepEqual(readdirSync(dir).sort(), ["deep"]);
});
