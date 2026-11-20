import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import xterm from "@xterm/headless";
import { Block, type Action } from "./contracts.ts";
import { CleanupError, launch } from "./process.ts";

const helper = fileURLToPath(new URL("./pty_bridge.py", import.meta.url));
const keys: Record<string, string> = { enter: "\r", escape: "\x1b", tab: "\t", backspace: "\x7f", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", "ctrl-c": "\x03" };

export async function observePty(executable: string, args: string[], actions: Action[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  let pending = "", ready = false, exit: number | undefined, lastData = performance.now();
  let processed = Promise.resolve();
  const command = [executable, ...args];
  const invalid = () => new Block("pty-protocol", "Invalid PTY bridge response");
  const child = launch("/usr/bin/python3", ["-I", helper, ...command], { cwd, env, signal, ms: 40_000,
    stdout: (chunk) => {
      pending += chunk.toString("ascii");
      if (pending.length > 128 * 1024) throw invalid();
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const event: unknown = JSON.parse(line);
        if (typeof event !== "object" || event === null || !("kind" in event) || exit !== undefined) throw invalid();
        if (event.kind === "ready" && !ready && "argv" in event && JSON.stringify(event.argv) === JSON.stringify(command)) ready = true;
        else if (event.kind === "data" && ready && "data" in event && typeof event.data === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(event.data)) {
          lastData = performance.now();
          const bytes = Buffer.from(event.data, "base64");
          processed = new Promise<void>((resolve) => { terminal.write(bytes, resolve); }); // callback follows all previous writes
        } else if (event.kind === "exit" && ready && "code" in event && typeof event.code === "number" && Number.isInteger(event.code)) exit = event.code;
        else throw invalid();
      }
    },
  });
  const ended = child.done.then((result) => { throw new Block("pty-ended", `PTY exited before observation completed (${result.code}): ${result.stderr.slice(0, 600)}`); });
  void ended.catch(() => {});
  const pause = (ms: number) => Promise.race([sleep(ms, undefined, { signal }), ended]);
  const send = (msg: object) => { child.input.write(JSON.stringify(msg) + "\n"); };
  const screens: { step: number; screen: string }[] = [];
  try {
    const deadline = performance.now() + 3000;
    while (!ready && performance.now() < deadline) await pause(20);
    if (!ready) throw new Block("pty-launch", "PTY did not confirm the staged launch");
    for (const [i, action] of actions.entries()) {
      signal.throwIfAborted();
      if (exit !== undefined) throw new Block("pty-ended", `Product exited before PTY step ${i + 1}`);
      if (action.type === "press") send({ type: "write", text: keys[action.key] });
      else if (action.type === "type") send({ type: "write", text: action.text });
      else if (action.type === "resize") {
        terminal.resize(action.cols, action.rows);
        send(action);
      } else if (action.type === "wait") await pause(action.ms);
      else {
        const limit = performance.now() + 400;
        do { await pause(30); } while (performance.now() - lastData < 60 && performance.now() < limit);
        await Promise.race([processed, ended]);
        const buffer = terminal.buffer.active;
        const screen = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n").trimEnd();
        screens.push({ step: i + 1, screen });
      }
    }
    if (exit !== undefined) throw new Block("pty-ended", "Product exited before observation finished");
    child.input.end(JSON.stringify({ type: "stop" }) + "\n");
    const result = await child.done;
    if (result.code !== 0 || pending || exit === undefined) throw new Block("pty-protocol", `PTY did not close cleanly: ${result.stderr.slice(0, 600)}`);
    return screens;
  } catch (error) {
    // Allow the bridge to reap its child before falling back to group termination.
    if (!child.input.destroyed && !child.input.writableEnded) child.input.end(JSON.stringify({ type: "stop" }) + "\n");
    await child.done.catch((cleanup: unknown) => { if (cleanup instanceof CleanupError) throw cleanup; });
    throw error;
  } finally { terminal.dispose(); }
}
