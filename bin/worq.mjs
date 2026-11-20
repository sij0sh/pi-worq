#!/usr/bin/env node
// Inspect, steer and stop Worq agents from any terminal. Talks to <state>/ctl/<pid>.sock (JSON lines).
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const usage = `Usage: worq [--pid N] <command>
  sessions                    Pi sessions with Worq loaded
  list [ref]                  agents, or one agent in full
  log <ref> [-f]              agent activity (-f follows)
  spawn <kind> <task>         start an agent
  send <ref> <text>           steer, answer, or start the next round
  cancel <ref|all>            close or cancel; branch kept`;
const state = resolve(process.env.WORQ_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-worq"));
const ctl = join(state, "ctl");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const sockets = () => { try { return readdirSync(ctl).filter((n) => /^\d+\.sock$/.test(n)).map((n) => Number(n.slice(0, -5))).filter(alive); } catch { return []; } };
function call(pid, op, args = {}) {
  return new Promise((ok, fail) => {
    const socket = connect(join(ctl, `${pid}.sock`));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ op, args }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i === -1) return;
      socket.end();
      const reply = JSON.parse(buffer.slice(0, i));
      reply.ok ? ok(reply) : fail(new Error(reply.error));
    });
    socket.on("error", fail);
  });
}
async function main(argv) {
  const at = argv.indexOf("--pid");
  const pinned = at === -1 ? undefined : Number(argv.splice(at, 2)[1]);
  const [command, first, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") { console.log(usage); return; }
  const live = sockets();
  if (command === "sessions") { console.log(live.length ? live.map((p) => `pi ${p}`).join("\n") : "No Pi session with Worq is running."); return; }
  const pid = pinned ?? (live.length === 1 ? live[0] : undefined);
  if (!pid) throw new Error(live.length ? `Several sessions (${live.join(", ")}); pass --pid` : "No Pi session with Worq is running");
  const print = async (op, args) => console.log((await call(pid, op, args)).text);
  switch (command) {
    case "list": return print("list", first ? { ref: first } : {});
    case "spawn": return print("spawn", { kind: first, task: rest.join(" ") });
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
