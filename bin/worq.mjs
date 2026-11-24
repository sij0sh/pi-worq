#!/usr/bin/env node
// Inspect, steer and stop Worq agents from any terminal.
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { controlExtension, controlPipe, statePath, windows } from "../src/platform.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const usage = `Usage: worq [--pid N] <command>
  sessions                    Pi sessions with Worq loaded
  list [ref]                  agents, or one agent in full
  log <ref> [-f]              agent activity (-f follows)
  spawn <kind> --title "Short title" [--attach <plan>]... [--mode fast|thorough] <task>         start an agent
  send <ref> <text>           steer, answer, or start the next round
  cancel <ref|all>            close or cancel; branch kept`;
const ctl = join(statePath(), "ctl");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const sockets = () => {
  try {
    return readdirSync(ctl).filter(n => n.endsWith(controlExtension)).map(n => n.slice(0, -controlExtension.length))
      .filter(n => /^[1-9][0-9]*$/.test(n)).map(Number).filter(n => n <= 0x7fffffff && alive(n));
  } catch { return []; }
};
function call(pid, op, args = {}) {
  return new Promise((ok, fail) => {
    const marker = join(ctl, `${pid}${controlExtension}`);
    let path = marker, token;
    if (windows) {
      const entry = JSON.parse(readFileSync(marker, "utf8"));
      if (typeof entry.token !== "string" || !/^[0-9a-f]{64}$/.test(entry.token)) throw new Error("Invalid Worq endpoint");
      path = controlPipe(entry.id);
      token = entry.token;
    }
    const socket = connect(path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ op, args, token })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i === -1) return;
      socket.end();
      try {
        const reply = JSON.parse(buffer.slice(0, i));
        reply.ok ? ok(reply) : fail(new Error(reply.error));
      } catch (error) { fail(error); }
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Worq disconnected without a reply")));
  });
}
async function main(argv) {
  const at = argv.indexOf("--pid");
  const pinned = at === -1 ? undefined : Number(argv.splice(at, 2)[1]);
  if (at !== -1 && (!Number.isInteger(pinned) || pinned < 1 || pinned > 0x7fffffff)) throw new Error("Invalid --pid");
  const [command, first, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") { console.log(usage); return; }
  const live = sockets();
  if (command === "sessions") { console.log(live.length ? live.map((p) => `pi ${p}`).join("\n") : "No Pi session with Worq is running."); return; }
  const pid = pinned ?? (live.length === 1 ? live[0] : undefined);
  if (!pid) throw new Error(live.length ? `Several sessions (${live.join(", ")}); pass --pid` : "No Pi session with Worq is running");
  const print = async (op, args) => console.log((await call(pid, op, args)).text);
  switch (command) {
    case "list": return print("list", first ? { ref: first } : {});
    case "spawn": {
      let title, mode;
      const attach = [];
      while (rest[0]?.startsWith("--")) {
        const flag = rest.shift();
        if (flag === "--") break;
        if (!["--title", "--mode", "--attach"].includes(flag)) throw new Error(`Unknown spawn option ${flag}`);
        const value = rest.shift();
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
        if (flag === "--title") title = value;
        if (flag === "--mode") mode = value;
        if (flag === "--attach") attach.push(value);
      }
      if (!title) throw new Error("spawn requires --title");
      return print("spawn", { kind: first, title, attach, mode, task: rest.join(" ") });
    }
    case "send": return print("send", { ref: first, text: rest.join(" ") });
    case "cancel": return print("cancel", { ref: first });
    case "log": {
      const follow = rest.includes("-f");
      let since = 0;
      do {
        const { data } = await call(pid, "log", { ref: first, since });
        for (const entry of data) { console.log(entry.line); since = entry.seq; }
        if (follow) await sleep(1000);
      } while (follow);
      return;
    }
    default: throw new Error(`Unknown command ${command}\n${usage}`);
  }
}
main(process.argv.slice(2)).catch((error) => { console.error(`worq: ${error.message}`); process.exit(1); });
