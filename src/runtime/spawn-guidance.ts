import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorText } from "../contracts.ts";
import type { Ops } from "../control.ts";
import { contained, outsideCheckout } from "./skills.ts";

const MAX_BYTES = 16 * 1024;
const MAX_ROWS = 8;
const MAX_NOTE = 200;

export const spawnRuntimeRule = "For worq_spawn runtime, honor explicit user preferences first, even outside the shortlist. Otherwise, omit runtime fields when automatic routing (<agentDir>/worq/routing.json; guide in <agentDir>/worq/ROUTING.md) is configured, or choose a suitable listed sdk and model together, with thinking only if listed. For a partial preference, never replace a requested field; fill in only from an unambiguous compatible choice if needed, otherwise leave fields unset or ask. Without a suitable choice, leave runtime fields unset: routing.json defaults apply before Main/adapter defaults.";

function readGuidance(path: string) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("expected a regular file");
    if (stat.size > MAX_BYTES) throw new Error("file exceeds 16 KiB");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_BYTES) throw new Error("file exceeds 16 KiB");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}

const cells = (line: string) => line.startsWith("|") && line.endsWith("|")
  ? line.slice(1, -1).split("|").map(cell => cell.trim()) : [];

/** Snapshot operator data only. Shape checking does not imply runtime availability. */
export function loadSpawnGuidance(agentDir: string, spawn: Ops["spawn"]): { section?: string; warning?: string } {
  let raw: string;
  try {
    const profile = realpathSync(agentDir);
    const dir = join(profile, "worq");
    const path = join(dir, "SPAWN-GUIDANCE.md");
    if (!lstatSync(dir).isDirectory()) throw new Error("worq must be a directory, not a symlink");
    if (!lstatSync(path).isFile()) throw new Error("expected a regular file, not a symlink");
    const base = contained(profile, dir);
    const file = contained(base, path);
    if (base === profile || file === base) throw new Error("expected a file strictly inside the profile's worq directory");
    outsideCheckout(base);
    raw = readGuidance(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { warning: `SPAWN-GUIDANCE.md ignored: ${errorText(error)}` };
  }

  const schema = Type.Pick(spawn, ["sdk", "model", "thinking"]);
  const lines = raw.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/).map(line => line.trim());
  // No table at all is the shipped template's shape: nothing configured, so nothing to warn about.
  if (!lines.some(line => line.startsWith("|"))) return {};
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence) && !marker[2]) fence = undefined;
      continue;
    }
    if (fence || cells(lines[i]).join("|").toLowerCase() !== "sdk|model|thinking|use when") continue;
    const separator = cells(lines[i + 1] ?? "");
    if (separator.length !== 4 || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;

    const rows: string[] = [];
    let skipped = 0;
    for (const line of lines.slice(i + 2)) {
      if (!line.startsWith("|")) break;
      const values = cells(line);
      const [sdk, model, thinking, note] = values;
      const tuple = { sdk, model, ...(thinking ? { thinking } : {}) };
      if (values.length !== 4 || !sdk || !model || !note || note.length > MAX_NOTE ||
          values.some(cell => /[\p{C}\p{Zl}\p{Zp}]/u.test(cell)) || !Value.Check(schema, tuple) || rows.length === MAX_ROWS) {
        skipped++;
        continue;
      }
      rows.push(JSON.stringify({ ...tuple, "use when": note }).replaceAll("<", "\\u003c"));
    }
    return {
      ...(rows.length ? { section: `${spawnRuntimeRule}\nOperator-listed runtime choices (advisory, not automatic routing):\n${rows.join("\n")}` } : {}),
      ...(skipped ? { warning: `SPAWN-GUIDANCE.md: skipped ${skipped} invalid or excess row(s) (limit: ${MAX_ROWS} choices)` } : {}),
    };
  }
  return { warning: "SPAWN-GUIDANCE.md ignored: expected a table with sdk | model | thinking | use when" };
}
