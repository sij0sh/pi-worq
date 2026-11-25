import { Type, type Static } from "typebox";
import { array, Block, command, errorText, obj, text } from "./contracts.ts";
import { runProcess } from "./process.ts";
import { clean, one } from "./render.ts";

export const GateSpec = obj({
  name: Type.Optional(text(48)),
  ...command,
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

/** Tail-trim stderr + stdout to keep self-healing rejection messages tight for the worker. */
function failureExcerpt(stderr: string, stdout: string, maxChars = 460): string {
  const combined = clean([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"));
  if (!combined) return "(no output)";
  return combined.length > maxChars ? `…${combined.slice(-(maxChars - 1))}` : combined;
}

/**
 * Run deterministic gates sequentially. Stops on the first failure and throws Block("gate-failed")
 * so Conversation.finish.validate bounces the exact failure back to the worker without waking Main.
 */
export async function runGates(
  cwd: string,
  env: NodeJS.ProcessEnv,
  gates: readonly GateSpec[],
  signal: AbortSignal,
  log?: (line: string) => void,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const [i, gate] of gates.entries()) {
    signal.throwIfAborted();
    const name = labelOf(gate, i);
    const cmd = formatCmd(gate);
    const started = Date.now();
    const ms = (gate.timeoutSeconds ?? 120) * 1000;
    log?.(`gate ${name}: ${one(cmd, 180)}`);
    try {
      const out = await runProcess(gate.executable, gate.args, { cwd, env, signal, ms });
      const durationMs = Date.now() - started;
      if (out.code === 0) {
        results.push({ name, command: cmd, passed: true, code: 0, durationMs });
        log?.(`gate ${name}: pass (${durationMs}ms)`);
        continue;
      }
      const excerpt = failureExcerpt(out.stderr, out.stdout);
      results.push({ name, command: cmd, passed: false, code: out.code, durationMs, excerpt });
      log?.(`gate ${name}: fail (exit ${out.code}, ${durationMs}ms)`);
      throw new Block("gate-failed", `Pre-submit gate "${name}" failed (exit ${out.code}):\n${excerpt}`);
    } catch (error) {
      if (error instanceof Block && error.code === "gate-failed") throw error;
      if (signal.aborted) throw signal.reason;
      const durationMs = Date.now() - started;
      const msg = errorText(error);
      results.push({ name, command: cmd, passed: false, durationMs, excerpt: one(msg, 300) });
      log?.(`gate ${name}: error (${one(msg, 180)})`);
      throw new Block("gate-failed", `Pre-submit gate "${name}" failed: ${one(msg, 460)}`);
    }
  }
  return results;
}

export function formatGateLines(results: readonly GateResult[]): string[] {
  return results.map((r) => `  [${r.passed ? "pass" : "fail"}] ${r.name} (${r.durationMs}ms): ${one(r.command, 120)}${!r.passed && r.excerpt ? ` — ${one(r.excerpt, 160)}` : ""}`);
}
