import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { observe, type Outcome } from './telemetry.ts';
import { Block } from "./contracts.ts";

export class CleanupError extends Block {
  constructor(message: string) { super("cleanup-unconfirmed", message); }
}
export interface ProcessResult { code: number; stdout: string; stderr: string }
const LIMIT = 128 * 1024;
/** The interpreter that runs Worq is on PATH, so an agent finds `node` without searching for one. */
const safePath = [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
export const cleanEnv = { PATH: safePath, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

function killGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, sig); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** Own the whole process group, not just the launched program or inherited pipes. */
export function launch(executable: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; ms: number; report?: (value: Outcome) => void; stdout?: (chunk: Buffer) => void;
}) {
  if (options.signal.aborted) observe(options.report, { kind: 'cancelled' });
  options.signal.throwIfAborted();
  const child = (() => {
    try { return spawn(executable, args, { cwd: options.cwd, env: options.env, detached: true, stdio: "pipe" }); }
    catch (error) { observe(options.report, { kind: 'launch' }); throw error; }
  })();
  let failure: unknown;
  let cancelled = false;
  let abortWasCause = false;
  let cleanup: Promise<void> | undefined;
  let stdout: Buffer[] = [], stderr: Buffer[] = [];
  let outBytes = 0, errBytes = 0;
  const join = () => cleanup ??= (async () => {
    if (!child.pid) return;
    try {
      if (!killGroup(child.pid, "SIGTERM")) return;
      for (let i = 0; i < 40; i++) {
        await sleep(25);
        if (!killGroup(child.pid, i === 7 ? "SIGKILL" : 0)) return;
      }
    } catch (error) { throw new CleanupError(`Could not stop group ${child.pid}: ${String(error)}`); }
    throw new CleanupError(`Could not confirm group ${child.pid} terminated`);
  })();
  let abandon!: (error: unknown) => void;
  const unsafe = new Promise<never>((_, reject) => { abandon = reject; });
  const stop = (reason: unknown) => {
    failure ??= reason;
    void join().catch((error) => {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      abandon(error);
    });
  };
  const abort = () => { cancelled = true; abortWasCause = failure == null; stop(options.signal.reason); };
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Block("timeout", `Process timed out: ${executable}`)), options.ms);
  child.stdin.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > LIMIT) { stop(new Block("output-limit", `Output limit exceeded: ${executable}`)); return; }
    if (!options.stdout) stdout.push(chunk);
    else { try { options.stdout(chunk); } catch (error) { stop(error); } }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes > LIMIT) stop(new Block("output-limit", `Output limit exceeded: ${executable}`));
    else stderr.push(chunk);
  });
  child.on("error", (error) => { failure ??= new Block("launch", `${executable}: ${error.message}`); });
  // exit may precede close if a descendant holds a pipe open.
  child.on("exit", () => { void join().catch(() => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); }); });
  const closed = new Promise<ProcessResult>((resolve, reject) => {
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      void join().then(() => {
        if (failure) reject(failure);
        else if (code === null) reject(new Block("process-exit", `Process ended with ${signal ?? "no exit status"}: ${executable}`));
        else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        stdout = []; stderr = [];
      }, reject);
    });
  });
  const done = Promise.race([closed, unsafe]).catch((error: unknown) => {
    const code = error instanceof Block ? error.code : undefined;
    if (error instanceof CleanupError) observe(options.report, { kind: 'cleanup-unconfirmed', cancelled });
    else if (abortWasCause) observe(options.report, { kind: 'cancelled' });
    else if (code === 'timeout' || code === 'launch' || code === 'output-limit' || code === 'process-exit') observe(options.report, { kind: code });
    throw error;
  });
  void done.catch(() => {}); // interactive callers may still be setting up controls
  return { done, input: child.stdin, stop };
}

export async function runProcess(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; ms: number; report?: (value: Outcome) => void; stdin?: string }): Promise<ProcessResult> {
  const child = launch(executable, args, options);
  child.input.end(options.stdin ?? "");
  return child.done;
}

export async function git(cwd: string, signal: AbortSignal, ...args: string[]) {
  const result = await runProcess("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], {
    cwd, signal, ms: 30_000,
    env: { ...cleanEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Worq", GIT_AUTHOR_EMAIL: "worq@localhost", GIT_COMMITTER_NAME: "Worq", GIT_COMMITTER_EMAIL: "worq@localhost" },
  });
  if (result.code) throw new Block("git", `git ${args[0]}: ${result.stderr.trim().slice(0, 700) || `exit ${result.code}`}`);
  return result.stdout.trim();
}
