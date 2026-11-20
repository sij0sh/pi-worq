#!/usr/bin/env node
// Control a running Worq session from any terminal. Talks to <state>/ctl/<pid>.sock (JSON lines).
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const usage = `Usage: worq [--pid N] <command>
  ls                                   list Pi sessions with a control socket
  status                               run state, reports, agents, open items
  agents                               agents and open questions/reviews
  log <agent> [-f]                     agent activity (-f follows)
  send <agent> [--follow-up] <text>    message an agent (steer by default)
  interrupt <agent> <text>             abort the agent's turn and redirect it
  reply <q-id> <text>                  answer an agent's question
  review <g-id> approve|revise|escalate [text]
  escalate <id>                        hand a question/review to the user
  stop                                 stop the run`;
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
function take(argv, flag, value = false) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const [, v] = argv.splice(i, value ? 2 : 1);
  return value ? v : true;
}
async function main(argv) {
  const pinned = take(argv, "--pid", true);
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") { console.log(usage); return; }
  const live = sockets();
  if (command === "ls") { console.log(live.length ? live.map((p) => `pi ${p}`).join("\n") : "No Pi session with Worq is running."); return; }
  const pid = pinned ? Number(pinned) : live.length === 1 ? live[0] : undefined;
  if (!pid) throw new Error(live.length ? `Several sessions (${live.join(", ")}); pass --pid` : "No Pi session with Worq is running");
  const [first, ...words] = rest;
  const text = () => words.join(" ");
  switch (command) {
    case "status": case "agents": case "stop": console.log((await call(pid, command)).text); return;
    case "log": {
      const follow = take(rest, "-f");
      const agent = rest[0];
      let since = 0;
      do {
        const { data } = await call(pid, "log", { agent, lines: 60, since });
        for (const entry of data) { console.log(entry.line); since = entry.seq; }
        if (follow) await sleep(1000);
      } while (follow);
      return;
    }
    case "send": {
      const followUp = take(words, "--follow-up");
      console.log((await call(pid, "send", { agent: first, text: text(), mode: followUp ? "followUp" : "steer" })).text); return;
    }
    case "interrupt": console.log((await call(pid, "interrupt", { agent: first, text: text() })).text); return;
    case "reply": console.log((await call(pid, "reply", { id: first, text: text() })).text); return;
    case "review": {
      const [decision, ...note] = words;
      console.log((await call(pid, "review", { id: first, decision, ...(note.length ? { text: note.join(" ") } : {}) })).text); return;
    }
    case "escalate": console.log((await call(pid, "escalate", { id: first })).text); return;
    default: throw new Error(`Unknown command ${command}\n${usage}`);
  }
}
main(process.argv.slice(2)).catch((error) => { console.error(`worq: ${error.message}`); process.exit(1); });
