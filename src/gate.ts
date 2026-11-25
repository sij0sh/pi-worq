import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, parse, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { array, Block, command, errorText, obj, text } from "./contracts.ts";
import { windows } from "./platform.mjs";
import { CleanupError, runProcess } from "./process.ts";
import { clean, one } from "./render.ts";

export const GateSpec = obj({
  name: Type.Optional(text(48)),
  ...command,
  independent: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 300 })),
});
export type GateSpec = Static<typeof GateSpec>;
export const GateList = array(GateSpec, 4, 1);

export interface GateResult {
  name: string;
  command: string;
  passed: boolean;
  code?: number;
  durationMs: number;
  excerpt?: string;
}

const labelOf = (gate: GateSpec, index: number) => gate.name?.trim() || `gate-${index + 1}`;
const formatCmd = (gate: GateSpec) => [gate.executable, ...gate.args].join(" ");

function failureExcerpt(stderr: string, stdout: string, maxChars = 460): string {
  const combined = clean([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"));
  if (!combined) return "(no output)";
  return combined.length > maxChars ? `…${combined.slice(-(maxChars - 1))}` : combined;
}

// Preserve components for the filesystem: `link/../tool` need not mean `tool`.
function against(cwd: string, path: string): string {
  if (windows && /^[a-z]:[^\\/]/i.test(path)) {
    return `${resolve(cwd, `${path.slice(0, 2)}.`)}${sep}${path.slice(2)}`;
  }
  if (windows && /^[\\/](?![\\/])/.test(path)) return parse(cwd).root + path.slice(1);
  return isAbsolute(path) ? path : `${cwd}${sep}${path}`;
}

/** Resolve all gates before launching any. The Windows bridge supports only .exe. */
async function preflightGates(gates: readonly GateSpec[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return Promise.all(gates.map(async (gate, i) => {
    const name = gate.executable;
    const explicit = windows ? /[\\/:]/.test(name) : name.includes("/");
    const suffixes = windows ? (env.PATHEXT ?? "").split(";").filter((ext) => ext.toLowerCase() === ".exe") : [];
    const names = windows ? [...(/\.exe$/i.test(name) ? [name] : []), ...suffixes.map((ext) => name + ext)] : [name];
    const dirs = explicit ? [cwd] : (env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const executable of names) {
        signal.throwIfAborted();
        const path = against(against(cwd, dir), executable);
        try {
          if (!(await stat(path)).isFile()) continue;
          if (!windows) await access(path, constants.X_OK);
          signal.throwIfAborted();
          return path;
        } catch { signal.throwIfAborted(); }
      }
    }
    signal.throwIfAborted();
    throw new Block("gate-failed", `Pre-submit gate "${labelOf(gate, i)}": executable "${name}" unavailable. Install it on the command PATH or configure an explicit executable path${windows ? " to an .exe" : ""}.`);
  }));
}

/** Unmarked gates are barriers. Only contiguous, explicitly independent gates may overlap. */
export async function runGates(
  cwd: string,
  env: NodeJS.ProcessEnv,
  gates: readonly GateSpec[],
  signal: AbortSignal,
  log?: (line: string) => void,
): Promise<GateResult[]> {
  const executables = await preflightGates(gates, cwd, env, signal);
  const results: GateResult[] = [];
  const run = async (gate: GateSpec, i: number, live: AbortSignal): Promise<GateResult> => {
    live.throwIfAborted();
    const name = labelOf(gate, i);
    const cmd = formatCmd(gate);
    const started = performance.now();
    const ms = (gate.timeoutSeconds ?? 120) * 1000;
    log?.(`gate ${name}: ${one(cmd, 180)}`);
    try {
      const out = await runProcess(executables[i], gate.args, { cwd, env, signal: live, ms });
      const durationMs = Math.round(performance.now() - started);
      if (out.code === 0) {
        log?.(`gate ${name}: pass (${durationMs}ms)`);
        return { name, command: cmd, passed: true, code: 0, durationMs };
      }
      log?.(`gate ${name}: fail (exit ${out.code}, ${durationMs}ms)`);
      throw new Block("gate-failed", `Pre-submit gate "${name}" failed (exit ${out.code}):\n${failureExcerpt(out.stderr, out.stdout)}`);
    } catch (error) {
      if (error instanceof CleanupError) throw error;
      live.throwIfAborted();
      if (error instanceof Block && error.code === "gate-failed") throw error;
      const msg = errorText(error);
      log?.(`gate ${name}: error (${one(msg, 180)})`);
      throw new Block("gate-failed", `Pre-submit gate "${name}" failed: ${one(msg, 460)}`);
    }
  };
  for (let start = 0; start < gates.length;) {
    let end = start + 1;
    if (!gates[start].independent) {
      results.push(await run(gates[start], start, signal));
      start = end;
      continue;
    }
    while (gates[end]?.independent) end++;
    const batch = new AbortController();
    const live = AbortSignal.any([signal, batch.signal]);
    const pending = gates.slice(start, end).map((gate, index) => run(gate, start + index, live).catch((error) => {
      batch.abort(error);
      throw error;
    }));
    const settled = await Promise.allSettled(pending);
    for (const result of settled) if (result.status === "rejected" && result.reason instanceof CleanupError) throw result.reason;
    live.throwIfAborted();
    for (const result of settled) if (result.status === "fulfilled") results.push(result.value);
    start = end;
  }
  return results;
}

export function formatGateLines(results: readonly GateResult[]): string[] {
  return results.map((r) => `  [${r.passed ? "pass" : "fail"}] ${r.name} (${r.durationMs}ms): ${one(r.command, 120)}${!r.passed && r.excerpt ? ` — ${one(r.excerpt, 160)}` : ""}`);
}
