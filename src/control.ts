import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { array, Block, errorText, obj, parse, text } from "./contracts.ts";
import { GateList } from "./gate.ts";
import { controlExtension, controlPipe, windows } from "./platform.mjs";
import { formatSwarmCheck } from "./swarm-check.ts";
import { GROUP_PATTERN, KIND_PATTERN, REF_PATTERN, type Worq } from "./worq.ts";

const ref = Type.String({ pattern: REF_PATTERN, description: "Exact agent name from worq_spawn or worq_list" });
const group = Type.String({ minLength: 1, maxLength: 32, pattern: GROUP_PATTERN, description: "Optional swarm/batch group id" });
const groupTarget = Type.String({ pattern: `^group:${GROUP_PATTERN.slice(1)}`, description: "Cancel all live agents in a group" });
/** One schema for the Pi tools and the worq CLI. Kind is checked against the live catalog, not an enum. */
export function ops() {
  return {
    spawn: obj({
      kind: Type.String({ minLength: 1, maxLength: 64, pattern: KIND_PATTERN, description: "Installed agent package name" }),
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000, description: "What the agent should deliver; omit to run the package as written. At-sign mentions are literal." })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Optional 2–4 word title; generated when omitted" })),
      attach: Type.Optional(Type.Array(text(256), { maxItems: 16, description: "Exact plan/brief names, inline agent refs, or repo-relative paths under .agents/plans/ or .agents/briefs/" })),
      group: Type.Optional(group),
      notify: Type.Optional(Type.Union([Type.Literal("each"), Type.Literal("barrier")])),
      expect: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Expected member count for a barrier group" })),
      writePaths: Type.Optional(array(text(256), 32, 1)),
      gates: Type.Optional(GateList),
      sdk: Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]*$", description: "Harness id; defaults to pi" })),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Model ref for the harness; defaults to Main's model (pi) or the harness default" })),
      thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z]+$", description: "Thinking level; defaults to Main's when the model supports it" })),
    }),
    list: obj({ ref: Type.Optional(ref), group: Type.Optional(group) }),
    send: obj({ ref, text: text(6000) }),
    cancel: obj({ ref: Type.Union([ref, Type.Literal("all"), groupTarget]) }),
    /** Change a live agent's model and/or thinking level; keeps its session. */
    configure: obj({ ref, model: Type.Optional(text(200)), thinking: Type.Optional(text(32)) }),
    /** CLI only: activity after a sequence number. */
    log: obj({ ref, since: Type.Optional(Type.Integer({ minimum: 0 })) }),
  } satisfies Record<string, TSchema>;
}
export type Ops = ReturnType<typeof ops>;
export type Op = keyof Ops;

/** Tool and socket requests: never user authority, never a picker. */
export async function dispatch(worq: Worq, table: Ops, op: string, raw: unknown, signal?: AbortSignal): Promise<{ text: string; data?: unknown }> {
  if (!(op in table)) throw new Block("op", `Unknown operation ${op}`);
  const key = op as Op;
  const args = parse(table[key] as TSchema, raw ?? {}, op);
  switch (key) {
    case "spawn": {
      const request = args as Static<Ops["spawn"]>;
      const agent = await worq.launch(request, { caller: "main", signal });
      const attached = agent.attachments.length ? ` with ${agent.attachments.map((a) => a.path).join(", ")} attached` : "";
      const grouped = agent.group ? ` in group ${agent.group}` : "";
      return {
        text: `Spawned ${request.kind} agent ${agent.title} (${agent.ref})${grouped}${attached}. It runs in the background; its questions and submission notices arrive as Worq notifications.`,
        data: agent.group ? { ref: agent.ref, group: agent.group } : { ref: agent.ref },
      };
    }
    case "list": {
      const { ref, group } = args as Static<Ops["list"]>;
      if (ref && group) throw new Block("invalid-payload", "Pass either ref or group, not both");
      if (!group) return { text: worq.list(ref) };
      let text = worq.list(undefined, group);
      if (worq.hasGroupWriters(group)) {
        const check = await worq.checkGroup(group, "HEAD", signal);
        text = `${text}\n\n${formatSwarmCheck(check)}`;
      }
      return { text };
    }
    case "send": { const { ref, text } = args as Static<Ops["send"]>; return { text: worq.send(ref, text) }; }
    case "cancel": return { text: await worq.cancel((args as Static<Ops["cancel"]>).ref) };
    case "configure": { const { ref, model, thinking } = args as Static<Ops["configure"]>; return { text: await worq.configure(ref, { model, thinking }) }; }
    case "log": {
      const { ref, since } = args as Static<Ops["log"]>;
      const entries = worq.get(ref).tail(200, since ?? 0);
      return { text: entries.map((e) => e.line).join("\n") || "(no activity)", data: entries };
    }
  }
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
