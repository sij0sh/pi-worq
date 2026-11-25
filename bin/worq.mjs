#!/usr/bin/env node
// Inspect, steer and stop Worq agents from any terminal.
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { controlExtension, controlPipe, statePath, windows } from "../src/platform.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const usage = `Usage: worq [--pid N] <command>
  sessions                    Pi sessions with Worq loaded
  list [ref | --group <id>]   agents, one group, or one agent in full
  log <ref> [-f]              agent activity (-f follows)
  spawn <kind> [--title "Short title"] [--attach <plan>]... [--group <id>] [--notify each|barrier] [--expect N] [--sdk id] [--model ref] [--thinking level] [--] [task]
                              start an agent (task omitted: run the package as written)
  send <ref> <text>           steer, answer, or resume a parked agent
  cancel <ref|group:<id>|all> close or cancel; branch kept
  configure <ref> [--model provider/id] [--thinking level]   change a live agent's runtime`;
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
    case "list": {
      if (first === "--group") {
        const value = rest[0];
        if (!value || value.startsWith("--")) throw new Error("--group requires a value");
        return print("list", { group: value });
      }
      return print("list", first ? { ref: first } : {});
    }
    case "spawn": {
      if (!first || first.startsWith("-")) throw new Error("spawn requires a kind");
      let title;
      let group;
      let notify;
      let expect;
      const attach = [];
      const runtime = {};
      while (rest[0]?.startsWith("--")) {
        const flag = rest.shift();
        if (flag === "--") break;
        if (!["--title", "--attach", "--group", "--notify", "--expect", "--sdk", "--model", "--thinking"].includes(flag)) throw new Error(`Unknown spawn option ${flag}`);
        const value = rest.shift();
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
        if (flag === "--title") title = value;
        else if (flag === "--attach") attach.push(value);
        else if (flag === "--group") group = value;
        else if (flag === "--notify") notify = value;
        else if (flag === "--expect") {
          if (!/^\d+$/.test(value)) throw new Error("--expect requires a positive integer");
          expect = Number(value);
        }
        else runtime[flag.slice(2)] = value;
      }
      const task = rest.join(" ");
      // Legacy shape (title and task given, no runtime/swarm flags) is sent exactly as older releases did.
      const modern = !title || !task || Object.keys(runtime).length > 0 || group !== undefined || notify !== undefined || expect !== undefined;
      const args = modern
        ? {
          kind: first,
          ...(title ? { title } : {}),
          ...(attach.length ? { attach } : {}),
          ...(group !== undefined ? { group } : {}),
          ...(notify !== undefined ? { notify } : {}),
          ...(expect !== undefined ? { expect } : {}),
          ...runtime,
          ...(task ? { task } : {}),
        }
        : { kind: first, title, attach, task };
      try { return await print("spawn", args); }
      catch (error) {
        // An older host's strict schema rejects omitted title/task and runtime/swarm fields. Never retried.
        if (modern && /^spawn: \/(?:title|task|group|notify|expect|sdk|model|thinking)? /.test(error.message)) {
          error.message += `\nThe running Worq may be older than this CLI: omitting --title or the task, and --group/--notify/--expect/--sdk/--model/--thinking, need a matching upgrade. With an older Worq use: worq spawn <kind> --title "Short title" [--attach <plan>] <task>`;
        }
        throw error;
      }
    }
    case "send": return print("send", { ref: first, text: rest.join(" ") });
    case "cancel": return print("cancel", { ref: first });
    case "configure": {
      const args = { ref: first };
      while (rest.length) {
        const flag = rest.shift();
        const value = rest.shift();
        if (!["--model", "--thinking"].includes(flag) || !value) throw new Error(`Usage: worq configure <ref> [--model provider/id] [--thinking level]`);
        args[flag.slice(2)] = value;
      }
      return print("configure", args);
    }
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
