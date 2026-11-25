import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windows } from "./platform.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { observe, type Outcome } from './telemetry.ts';
import { Block } from "./contracts.ts";

export class CleanupError extends Block {
  constructor(message: string) { super("cleanup-unconfirmed", message); }
}
export interface ProcessResult { code: number; stdout: string; stderr: string }
const LIMIT = 128 * 1024;
const jobBridge = fileURLToPath(new URL("./job_bridge.py", import.meta.url));
const systemRoot = process.env.SystemRoot ?? "C:/Windows";
function findExe(name: string) {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, "");
    if (!isAbsolute(dir)) continue;
    const path = join(dir, name);
    try { if (statSync(path).isFile()) return path; } catch { /* Try the next PATH entry. */ }
  }
}
const gitExe = windows ? findExe("git.exe") : "/usr/bin/git";
const pythonExe = windows ? findExe("python.exe") : undefined;
/** Only the interpreter and fixed toolchain directories, not the ambient environment. */
const safePath = [dirname(process.execPath), ...(windows
  ? [gitExe && dirname(gitExe), pythonExe && dirname(pythonExe), join(systemRoot, "System32"), systemRoot]
  : ["/usr/local/bin", "/usr/bin", "/bin"])].filter(Boolean).join(delimiter);
export const cleanEnv: NodeJS.ProcessEnv = { PATH: safePath, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  ...(windows ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATHEXT: ".EXE", NoDefaultCurrentDirectoryInExePath: "1" } : {}) };

function killGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, sig); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** Own the whole process group (Linux) or Job Object (Windows). */
export function launch(executable: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; ms: number; report?: (value: Outcome) => void; stdout?: (chunk: Buffer) => void;
}) {
  if (options.signal.aborted) observe(options.report, { kind: 'cancelled' });
  options.signal.throwIfAborted();
  const child = (() => {
    try {
      if (windows && !pythonExe) throw new Block("launch", "Worq requires Python 3.12+ (python.exe on PATH)");
      return spawn(windows ? pythonExe! : executable, windows ? ["-I", jobBridge, String(process.pid), executable, ...args] : args, {
        cwd: options.cwd, env: options.env, detached: !windows, windowsHide: true, stdio: windows ? ["pipe", "pipe", "pipe", "pipe"] : "pipe",
      });
    }
    catch (error) { observe(options.report, { kind: 'launch' }); throw error; }
  })();
  let failure: unknown;
  let control = "";
  const status = windows ? child.stdio[3] : undefined;
  let cancelled = false;
  let abortWasCause = false;
  let cleanup: Promise<void> | undefined;
  let stdout: Buffer[] = [], stderr: Buffer[] = [];
  let outBytes = 0, errBytes = 0;
  const join = () => cleanup ??= (async () => {
    if (!child.pid) return;
    try {
      if (windows) {
        // Terminating the owner closes the only Job handle; Windows terminates its members.
        const exited = () => child.exitCode !== null || child.signalCode !== null;
        if (exited()) return;
        child.kill("SIGKILL"); // May race with normal completion; wait for exit either way.
        for (let i = 0; i < 80; i++) {
          await sleep(25);
          if (exited()) return;
        }
        throw new Error("Could not confirm the job owner exited");
      }
      if (!killGroup(child.pid, "SIGTERM")) return;
      for (let i = 0; i < 40; i++) {
        await sleep(25);
        if (!killGroup(child.pid, i === 7 ? "SIGKILL" : 0)) return;
      }
    } catch (error) { throw new CleanupError(`Could not stop ${windows ? "job" : "group"} ${child.pid}: ${String(error)}`); }
    throw new CleanupError(`Could not confirm ${windows ? "job" : "group"} ${child.pid} terminated`);
  })();
  let abandon!: (error: unknown) => void;
  const unsafe = new Promise<never>((_, reject) => { abandon = reject; });
  const stop = (reason: unknown) => {
    failure ??= reason;
    void join().catch((error) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy(); status?.destroy(); child.unref();
      abandon(error);
    });
  };
  const abort = () => { cancelled = true; abortWasCause = failure == null; stop(options.signal.reason); };
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Block("timeout", `Process timed out: ${executable}`)), options.ms);
  child.stdin!.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > LIMIT) { stop(new Block("output-limit", `Output limit exceeded: ${executable}`)); return; }
    if (!options.stdout) stdout.push(chunk);
    else { try { options.stdout(chunk); } catch (error) { stop(error); } }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes > LIMIT) stop(new Block("output-limit", `Output limit exceeded: ${executable}`));
    else stderr.push(chunk);
  });
  status?.on("data", (chunk: Buffer) => {
    control += chunk.toString("ascii");
    if (control.length > 8192) stop(new CleanupError("Oversize Windows job status"));
  });
  status?.on("error", (error) => stop(new CleanupError(`Could not read Windows job status: ${error.message}`)));
  child.on("error", (error) => { failure ??= new Block("launch", `${executable}: ${error.message}`); });
  // exit may precede close if a descendant holds a pipe open.
  if (!windows) child.on("exit", () => { void join().catch(() => { child.stdout!.destroy(); child.stderr!.destroy(); child.stdin!.destroy(); }); });
  const closed = new Promise<ProcessResult>((resolve, reject) => {
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      void join().then(() => {
        try {
          if (failure) throw failure;
          if (windows) {
            const events = control.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return undefined; } });
            const [first, last] = events;
            if (code === 0 && events.length === 1 && first?.kind === "launch" && typeof first.message === "string") {
              throw new Block("launch", `${executable}: ${first.message}`);
            }
            if (code !== 0 || events.length !== 2 || first?.kind !== "ready" || last?.kind !== "exit" || !Number.isInteger(last.code)) {
              throw new CleanupError(`Windows job owner exited without confirmation: ${executable}`);
            }
            code = last.code as number;
          }
          if (code === null) throw new Block("process-exit", `Process ended with ${signal ?? "no exit status"}: ${executable}`);
          resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        } catch (error) { reject(error); }
        finally { stdout = []; stderr = []; }
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
  return { done, input: child.stdin!, stop };
}

export async function runProcess(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; ms: number; report?: (value: Outcome) => void; stdin?: string }): Promise<ProcessResult> {
  const child = launch(executable, args, options);
  child.input.end(options.stdin ?? "");
  return child.done;
}

export async function gitRaw(cwd: string, signal: AbortSignal, ...args: string[]): Promise<ProcessResult> {
  if (!gitExe) throw new Block("launch", "Worq requires Git for Windows (git.exe on PATH)");
  return runProcess(gitExe, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false",
    ...args], {
    cwd, signal, ms: 30_000,
    env: { ...cleanEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: windows ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Worq", GIT_AUTHOR_EMAIL: "worq@localhost", GIT_COMMITTER_NAME: "Worq", GIT_COMMITTER_EMAIL: "worq@localhost" },
  });
}

export async function git(cwd: string, signal: AbortSignal, ...args: string[]) {
  const result = await gitRaw(cwd, signal, ...args);
  if (result.code) throw new Block("git", `git ${args[0]}: ${result.stderr.trim().slice(0, 700) || `exit ${result.code}`}`);
  return result.stdout.trim();
}
