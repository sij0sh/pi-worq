import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Block, errorText, literals, obj, parse, text } from "./contracts.ts";
import { controlExtension, controlPipe, windows } from "./platform.mjs";
import { REF_PATTERN, type Worq } from "./worq.ts";

const ref = Type.String({ pattern: REF_PATTERN, description: "Exact agent name from worq_spawn or worq_list" });
/** One schema for the Pi tools, /worq subcommands and the worq CLI. */
export function ops(kinds: string[]) {
  return {
    spawn: obj({
      kind: literals(kinds as [string, ...string[]]),
      task: Type.String({ minLength: 1, maxLength: 8000, description: "What the agent should deliver. At-sign mentions are literal." }),
      title: Type.String({ minLength: 1, maxLength: 80, description: "A 2–4 word title summarizing this work" }),
      attach: Type.Optional(Type.Array(text(256), { maxItems: 16, description: "Exact plan names or repo-relative paths under .agents/plans/" })),
      reason: Type.Optional(text(400)),
      mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("thorough")])),
      verify: Type.Optional(Type.Boolean({ description: "execute only; false skips the verifier" })),
    }),
    list: obj({ ref: Type.Optional(ref) }),
    send: obj({ ref, text: text(6000) }),
    cancel: obj({ ref: Type.Union([ref, Type.Literal("all")]) }),
    /** Change a live agent's model and/or thinking level; keeps its session. */
    configure: obj({ ref, model: Type.Optional(text(200)), thinking: Type.Optional(text(32)) }),
    /** CLI only: activity after a sequence number. */
    log: obj({ ref, since: Type.Optional(Type.Integer({ minimum: 0 })) }),
  } satisfies Record<string, TSchema>;
}
export type Ops = ReturnType<typeof ops>;
export type Op = keyof Ops;

export async function dispatch(worq: Worq, table: Ops, op: string, raw: unknown, signal?: AbortSignal): Promise<{ text: string; data?: unknown }> {
  if (!(op in table)) throw new Block("op", `Unknown operation ${op}`);
  const key = op as Op;
  const args = parse(table[key] as TSchema, raw ?? {}, op);
  switch (key) {
    case "spawn": {
      const { kind, task, verify, mode, reason, title, attach } = args as Static<Ops["spawn"]>;
      const agent = await worq.spawn(kind, task, { verify, mode, reason, title, attach }, signal);
      const attached = agent.attachments.length ? ` with ${agent.attachments.map((a) => a.path).join(", ")} attached` : "";
      return { text: `Spawned ${kind} agent ${agent.title} (${agent.ref})${attached}. It runs in the background; its review digest or questions arrive as Worq notifications.`, data: { ref: agent.ref } };
    }
    case "list": return { text: worq.list((args as Static<Ops["list"]>).ref) };
    case "send": { const { ref, text } = args as Static<Ops["send"]>; return { text: worq.send(ref, text) }; }
    case "cancel": return { text: await worq.cancel((args as Static<Ops["cancel"]>).ref) };
    case "configure": { const { ref, model, thinking } = args as Static<Ops["configure"]>; return { text: await worq.configure(ref, { model, thinking }) }; }
    case "log": {
      const { ref, since } = args as Static<Ops["log"]>;
      const entries = worq.get(ref).tail(200, since ?? 0);
      return { text: entries.map((e) => e.line).join("\n") || "(no activity)", data: entries };
    }
  }
  throw new Block("op", `Unhandled operation ${op}`);
}

/** Unix socket or authenticated Windows named pipe, discovered in the state directory. */
export async function serve(state: string, handle: (op: string, args: unknown) => Promise<{ text: string; data?: unknown }>) {
  const dir = join(state, "ctl");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!windows) await chmod(dir, 0o700);
  const marker = join(dir, `${process.pid}${controlExtension}`);
  const id = windows ? randomBytes(16).toString("hex") : undefined;
  const token = windows ? randomBytes(32).toString("hex") : undefined;
  const path = id ? controlPipe(id) : marker;
  if (!windows) await rm(marker, { force: true });
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
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
            const request = JSON.parse(line) as { op: string; args?: unknown; token?: string };
            if (token && request.token !== token) { socket.destroy(); return; }
            socket.write(`${JSON.stringify({ ok: true, ...(await handle(request.op, request.args)) })}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify({ ok: false, error: errorText(error) })}\n`);
          }
        })();
      }
    });
    socket.on("error", () => {});
  });
  server.unref();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
  const close = async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(marker, { force: true });
  };
  try {
    if (windows) await writeFile(marker, JSON.stringify({ id, token }));
    else await chmod(marker, 0o600);
  } catch (error) { await close(); throw error; }
  return { path, close };
}
