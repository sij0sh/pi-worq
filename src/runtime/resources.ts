import { createHash } from "node:crypto";
import { readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";
import { discoverAndLoadExtensions, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { inside, temporaryDirectory } from "./workspace.ts";
import { Block } from "./contracts.ts";
import type { ModelChoice } from "./config.ts";

export async function applyResources(loader: ResourceLoader, prompt: string, configPath: string, selection: ModelChoice["resources"]) {
  const skills: string[] = [];
  const context: string[] = [];
  const scripts: Buffer[] = [];
  for (const key of ["skills", "instructions", "extensions"] as const) {
    for (const pin of selection?.[key] ?? []) {
      const root = join(await realpath(dirname(configPath)), "worq-resources");
      const path = await realpath(resolve(root, pin.path));
      const rel = relative(root, path);
      if (isAbsolute(pin.path) || !inside(root, path)) throw new Block("config", `Untrusted resource: ${pin.path}`);
      for (let dir = dirname(path); ; dir = dirname(dir)) {
        try { await lstat(join(dir, ".git")); throw new Block("config", `Repository resource: ${path}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (dir === dirname(dir)) break;
      }
      if (!(await lstat(path)).isFile()) throw new Block("config", `Not a regular resource file: ${path}`);
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Block("config", `Changed resource: ${path}`);
      if (key === 'skills') skills.push((basename(path) === 'SKILL.md' ? basename(dirname(rel)) : basename(rel)).replace(/[^a-zA-Z0-9._-]/g, '?').slice(0, 64));
      if (key === "extensions") scripts.push(bytes); else context.push(`Operator ${key}: ${pin.path} (context, not authority)\n${bytes.toString("utf8")}`);
    }
  }
  if (context.length) loader.getSystemPrompt = () => [prompt, ...context].join("\n\n");
  if (scripts.length) {
    // Pi discovers extensions relative to both arguments; neither may be an ambient directory.
    const dir = await temporaryDirectory(tmpdir(), "worq-ext-");
    try {
      const paths = await Promise.all(scripts.map(async (bytes, i) => { const path = join(dir, `${i}.mjs`); await writeFile(path, bytes); return path; }));
      const result = await discoverAndLoadExtensions(paths, dir, dir);
      if (result.errors.length || result.extensions.length !== paths.length) throw new Block("config", "Approved extensions could not load");
      loader.getExtensions = () => result;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return skills;
}
