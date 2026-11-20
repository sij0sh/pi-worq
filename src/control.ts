import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Block, errorText, literals, obj, parse, text } from "./contracts.ts";
import type { Worq } from "./worq.ts";

const ref = Type.String({ pattern: "^@?[0-9a-fA-F]{4}$", description: "Agent ref from worq_spawn or worq_list" });
/** One schema for the Pi tools, /worq subcommands and the worq CLI. */
export function ops(kinds: string[]) {
  return {
    spawn: obj({
      kind: literals(kinds as [string, ...string[]]),
      task: Type.String({ minLength: 1, maxLength: 8000, description: "What the agent should deliver. Include @<ref> to attach another agent's plan." }),
    }),
    list: obj({ ref: Type.Optional(ref) }),
    send: obj({ ref, text: text(6000) }),
    cancel: obj({ ref: Type.Union([ref, Type.Literal("all")]) }),
    /** CLI only: activity after a sequence number. */
    log: obj({ ref, since: Type.Optional(Type.Integer({ minimum: 0 })) }),
  } satisfies Record<string, TSchema>;
}
export type Ops = ReturnType<typeof ops>;
export type Op = keyof Ops;

export async function dispatch(worq: Worq, table: Ops, op: string, raw: unknown): Promise<{ text: string; data?: unknown }> {
  if (!(op in table)) throw new Block("op", `Unknown operation ${op}`);
  const key = op as Op;
  const args = parse(table[key] as TSchema, raw ?? {}, op);
  switch (key) {
    case "spawn": {
      const { kind, task } = args as Static<Ops["spawn"]>;
      const agent = await worq.spawn(kind, task);
      const attached = agent.attachments.length ? ` with ${agent.attachments.map((a) => `@${a.ref}`).join(", ")} attached` : "";
      return { text: `Spawned ${kind} agent ${agent.ref}${attached}. It runs in the background; its review digest or questions arrive as [worq ${agent.ref}] messages.`, data: { ref: agent.ref } };
    }
    case "list": return { text: worq.list((args as Static<Ops["list"]>).ref) };
    case "send": { const { ref, text } = args as Static<Ops["send"]>; return { text: worq.send(ref, text) }; }
    case "cancel": return { text: await worq.cancel((args as Static<Ops["cancel"]>).ref) };
    case "log": {
      const { ref, since } = args as Static<Ops["log"]>;
      const entries = worq.get(ref).tail(200, since ?? 0);
      return { text: entries.map((e) => e.line).join("\n") || "(no activity)", data: entries };
    }
  }
  throw new Block("op", `Unhandled operation ${op}`);
}

/** JSON-lines control socket at <state>/ctl/<pid>.sock (dir 0700, socket 0600). */
export async function serve(state: string, handle: (op: string, args: unknown) => Promise<{ text: string; data?: unknown }>) {
  const dir = join(state, "ctl");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, `${process.pid}.sock`);
  await rm(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) { socket.destroy(); return; }
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        void (async () => {
          try {
            const { op, args } = JSON.parse(line) as { op: string; args?: unknown };
            socket.write(JSON.stringify({ ok: true, ...(await handle(op, args)) }) + "\n");
          } catch (error) {
            socket.write(JSON.stringify({ ok: false, error: errorText(error) }) + "\n");
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
