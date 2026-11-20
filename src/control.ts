import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Block, obj, parse, text } from "./contracts.ts";
import type { Run } from "./controller.ts";

const ref = Type.String({ pattern: "^[a-z]\\d{1,6}$" });
const message = text(4000);
/** Manager operations. Pi tools, /worq subcommands and the `worq` CLI all go through `dispatch`. */
export const Ops = {
  status: obj({}),
  agents: obj({}),
  log: obj({ agent: ref, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })), since: Type.Optional(Type.Integer({ minimum: 0 })) }),
  send: obj({ agent: ref, text: message, mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])) }),
  interrupt: obj({ agent: ref, text: message }),
  reply: obj({ id: ref, text: message }),
  review: obj({ id: ref, decision: Type.Union([Type.Literal("approve"), Type.Literal("revise"), Type.Literal("escalate")]), text: Type.Optional(message),
    route: Type.Optional(Type.Union([Type.Literal("product"), Type.Literal("design"), Type.Literal("intent")])) }),
  escalate: obj({ id: ref, note: Type.Optional(text(600)) }),
  stop: obj({}),
};
export type Op = keyof typeof Ops;
export interface Host {
  run(): Run | undefined;
  report(run: Run): string;
}

function agentsText(run: Run) {
  const bus = run.bus;
  const agents = bus?.agentsView() ?? [];
  const pending = bus?.pendingView() ?? [];
  return [
    agents.length ? "Agents:" : "No agents yet.",
    ...agents.map((a) => `${a.id} · ${a.role} · ${a.state} · ${a.turns} turns${a.sealed ? " · sealed" : ""}${a.last ? `\n    ${a.last}` : ""}`),
    ...(pending.length ? ["Open:", ...pending.map((p) => `${p.id} · ${p.kind === "ask" ? `${p.agent} asks` : `${p.gate} review`}: ${p.body.replace(/\s+/g, " ").slice(0, 200)}`)] : []),
  ].join("\n");
}

export async function dispatch(host: Host, op: string, raw: unknown): Promise<{ text: string; data?: unknown }> {
  if (!(op in Ops)) throw new Block("op", `Unknown operation ${op}`);
  const key = op as Op;
  const args = parse(Ops[key], raw ?? {}, op) as Static<(typeof Ops)[Op]> & Record<string, never>;
  const run = host.run();
  if (!run) throw new Block("no-run", "No Worq run in this session");
  const bus = run.bus;
  if (key === "status") return { text: `${host.report(run)}\n\n${agentsText(run)}` };
  if (key === "stop") {
    void run.stop();
    return { text: "Stopping the run" };
  }
  if (!bus) throw new Block("not-ready", "The run has not loaded its profile yet");
  switch (key) {
    case "agents": return { text: agentsText(run), data: { agents: bus.agentsView(), pending: bus.pendingView() } };
    case "log": {
      const { agent, lines, since } = args as Static<typeof Ops.log>;
      const entries = bus.log(agent, lines ?? 20, since ?? 0);
      return { text: entries.map((e) => e.line).join("\n") || "(no activity)", data: entries };
    }
    case "send": { const { agent, text, mode } = args as Static<typeof Ops.send>; return { text: bus.send(agent, text, mode) }; }
    case "interrupt": { const { agent, text } = args as Static<typeof Ops.interrupt>; return { text: await bus.interrupt(agent, text) }; }
    case "reply": { const { id, text } = args as Static<typeof Ops.reply>; return { text: bus.reply(id, text) }; }
    case "review": { const { id, decision, text, route } = args as Static<typeof Ops.review>; return { text: bus.review(id, decision, text, route) }; }
    case "escalate": {
      const { id, note } = args as Static<typeof Ops.escalate>;
      void bus.escalate(id, note).catch(() => {});
      return { text: `Escalated ${id} to the user` };
    }
  }
  throw new Block("op", `Unhandled operation ${op}`);
}

/** JSON-lines control socket at <state>/ctl/<pid>.sock (directory 0700, socket 0600). */
export async function serve(state: string, host: Host): Promise<{ path: string; close(): Promise<void> }> {
  const dir = join(state, "ctl");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, `${process.pid}.sock`);
  await rm(path, { force: true });
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void (async () => {
          try {
            const { op, args } = JSON.parse(line) as { op: string; args?: unknown };
            const result = await dispatch(host, op, args);
            socket.write(JSON.stringify({ ok: true, ...result }) + "\n");
          } catch (error) {
            socket.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
          }
        })();
      }
    });
    socket.on("error", () => {});
  });
  server.unref();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
  await chmod(path, 0o600);
  return { path, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(path, { force: true }); } };
}
