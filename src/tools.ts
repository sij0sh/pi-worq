import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { Type } from "typebox";
import { array, Block, command, errorText, obj, PtyAction, text } from "./contracts.ts";
import { CleanupError, launch, runProcess } from "./process.ts";
import { windows } from "./platform.mjs";
import { observePty } from "./pty.ts";
import { one } from "./render.ts";
import { tool, type Tool } from "./sdk/contract.ts";
import { readSmall, runtimeEnv, scoped, writeScoped, type Runtime } from "./workspace.ts";

const path = text(1024);
const SEARCH = { hits: 200, bytes: 64_000, files: 4_000, file: 2 * 1024 * 1024 };

/**
 * Bounded content search: `read_file` shows 160 lines per call, so locating a symbol otherwise costs
 * a dozen calls. Symlinks are refused, except the dependency links a checkout is given.
 */
function searchTool(cwd: string): Tool {
  return tool("search", "Search a file or directory for a regular expression; returns path:line:text, bounded",
    obj({ pattern: text(200), path: Type.Optional(path) }), async ({ pattern, path: at = "." }, _signal, report) => {
      let match: RegExp;
      try { match = new RegExp(pattern); } catch (error) { throw new Block("pattern", `Invalid regular expression: ${errorText(error)}`); }
      const start = await realpath(await scoped(cwd, at, { root: true }));
      // Match the walk's resolved paths so Windows short names cannot leak into the output.
      const base = await realpath(cwd).catch(() => cwd);
      const lines: string[] = [];
      let bytes = 0, files = 0, capped = false;
      const read = async (file: string) => {
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile() || info.size > SEARCH.file) return;
        files++;
        const raw = await readFile(file, "utf8").catch(() => undefined);
        if (raw === undefined || raw.includes("\0")) return;
        const rows = raw.split(/\r?\n/);
        for (let i = 0; i < rows.length; i++) {
          if (!match.test(rows[i])) continue;
          const line = `${relative(base, file).split(sep).join("/")}:${i + 1}:${one(rows[i].trim(), 300)}`;
          if (lines.length >= SEARCH.hits || bytes + line.length > SEARCH.bytes) { capped = true; return; }
          lines.push(line);
          bytes += line.length + 1;
        }
      };
      const walk = async (dir: string, modules: boolean): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (files >= SEARCH.files || capped) return;
          if (entry.name.toLowerCase() === ".git") continue;
          const full = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            if (!modules) continue;
            const real = await realpath(full).catch(() => undefined);
            const info = real ? await stat(real).catch(() => undefined) : undefined;
            if (real && info?.isDirectory()) await walk(real, false);
            else if (real && info?.isFile()) await read(real);
            continue;
          }
          if (entry.isDirectory()) await walk(full, entry.name === "node_modules");
          else await read(full);
        }
      };
      const info = await stat(start);
      // Do not grant the dependency-link exception to an explicitly selected starting directory.
      if (info.isDirectory()) await walk(start, false);
      else if (info.isFile()) await read(start);
      report?.({ kind: 'search', count: lines.length, capped: capped || files >= SEARCH.files });
      if (!lines.length) return `No matches in ${files} files${capped ? " (search stopped at a cap)" : ""}`;
      return lines.join("\n") + (capped ? `\n(${files} files scanned; results capped)` : "");
    });
}

/** Read-only repository tools. Every profile gets these. */
export function readTools(cwd: string): Tool[] {
  return [
    tool("list_files", "List a directory (relative path, . for root)", obj({ path }), async ({ path }) => {
      const entries = await readdir(await scoped(cwd, path, { root: true }), { withFileTypes: true });
      return entries.filter((e) => e.name.toLowerCase() !== ".git" && !e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 250)
        .map((e) => e.name + (e.isDirectory() ? "/" : "")).join("\n") || "(empty)";
    }),
    tool("read_file", "Read a text file with a 1-based offset and an optional line limit (1–160, default 160)", obj({
      path, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 160 })),
    }), async ({ path, offset = 1, limit = 160 }) => {
      const raw = await readSmall(await scoped(cwd, path), 256 * 1024);
      if (raw.includes("\0")) throw new Block("binary", "Binary files are not exposed");
      return raw.split(/\r?\n/).slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join("\n").slice(0, 20_000);
    }),
    searchTool(cwd),
  ];
}

/** File edits inside an execute agent's worktree. */
export function writeTools(cwd: string): Tool[] {
  return [
    tool("write_file", "Create or replace a complete UTF-8 file", obj({ path, content: Type.String({ maxLength: 80_000 }) }), async ({ path, content }) => {
      await writeScoped(cwd, path, content);
      return `Wrote ${path}`;
    }),
    tool("edit_file", "Replace one exact, unique text region in a file (parameters: path, old, replacement)", obj({ path, old: text(25_000), replacement: Type.String({ maxLength: 40_000 }) }), async ({ path, old, replacement }) => {
      const before = await readSmall(await scoped(cwd, path), 256 * 1024);
      // read_file renders CRLF as lines. Match LF input against a CRLF file without changing its EOL style.
      if (before.includes("\r\n") && !before.replaceAll("\r\n", "").includes("\n")) {
        const crlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
        old = crlf(old);
        replacement = crlf(replacement);
      }
      const at = before.indexOf(old);
      if (at === -1 || before.indexOf(old, at + 1) !== -1) throw new Block("edit-match", "Old text must match exactly once");
      await writeScoped(cwd, path, before.slice(0, at) + replacement + before.slice(at + old.length));
      return `Edited ${path}`;
    }),
    tool("delete_file", "Remove one regular file", obj({ path }), async ({ path }) => {
      const target = await scoped(cwd, path);
      if (!(await lstat(target)).isFile()) throw new Block("delete", "Only regular files can be removed");
      await unlink(target);
      return `Removed ${path}`;
    }),
  ];
}

/**
 * Process-running tools (commands, services, terminals) with owned cleanup.
 * `verify` adds services, terminal observation and artifact saving for execute reviewers.
 */
export function processTools(cwd: string, runtime: string, options: { verify?: { artifacts: string; services: number }; signal: AbortSignal }) {
  const running = new Set<Promise<unknown>>();
  let cleanupError: CleanupError | undefined;
  const track = <T>(pending: Promise<T>) => {
    running.add(pending);
    void pending.then(() => running.delete(pending), (error: unknown) => { if (error instanceof CleanupError) cleanupError = error; running.delete(pending); });
    return pending;
  };
  const sig = (signal: AbortSignal) => AbortSignal.any([options.signal, signal]);
  let env: Promise<Runtime> | undefined;
  const environment = () => env ??= runtimeEnv(runtime);
  const tools: Tool[] = [
    tool("run_command", "Run a trusted local command in this checkout; no shell parsing. Returns exit code and output tails.",
      obj({ ...command, stdin: Type.Optional(Type.String({ maxLength: 8192 })) }), async ({ executable, args, stdin }, signal, report) => {
        const out = await track(runProcess(executable, args, { cwd, env: (await environment()).env, signal: sig(signal), ms: 120_000, stdin, report }));
        report?.({ kind: 'exit', code: out.code, stdout: !!out.stdout, stderr: !!out.stderr });
        return `Exit ${out.code}\nstdout:\n${out.stdout.slice(-6000)}\nstderr:\n${out.stderr.slice(-6000)}`;
      }),
  ];
  const saved: string[] = [];
  if (options.verify) {
    const { artifacts, services: max } = options.verify;
    const services: { output: string; status: string }[] = [];
    tools.push(
      tool("start_service", "Launch a local test server from this checkout, bound to loopback. Stopped when you finish.", obj(command), async ({ executable, args }) => {
        if (services.length >= max) throw new Block("service-limit", `At most ${max} services`);
        const service = { output: "", status: "running" };
        const child = launch(executable, args, { cwd, env: (await environment()).env, signal: options.signal, ms: 600_000,
          stdout: (chunk) => { service.output = (service.output + chunk.toString()).slice(-4000); } });
        services.push(service);
        void track(child.done).then(({ code, stderr }) => { service.status = `Exit ${code}\n${stderr.slice(-1500)}`; }, (error) => { service.status = String(error); });
        return `Started service ${services.length}. Poll service_status until it is ready.`;
      }),
      tool("service_status", "Read a service's status and recent output", obj({ id: Type.Integer({ minimum: 1, maximum: 8 }) }), ({ id }) => {
        const service = services[id - 1];
        if (!service) throw new Block("no-service", `No service ${id}`);
        return `${service.status}\n${service.output}`;
      }),
      ...(!windows ? [tool("observe_terminal", "Launch an interactive terminal app, drive inputs, and return rendered screens at observe steps",
        obj({ ...command, actions: array(PtyAction, 16, 1) }), async ({ executable, args, actions }, signal) => {
          const screens = await track(observePty(executable, args, actions, cwd, (await environment()).env, sig(signal)));
          return screens.map(({ step, screen }) => `Step ${step}:\n${screen}`).join("\n\n").slice(-12_000) || "No screens requested";
        })] : []),
      tool("save_artifact", "Keep a screenshot or text observation from this checkout as evidence", obj({ path }), async ({ path }) => {
        const name = basename(path);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || !/\.(png|jpe?g|webp|txt|md|log)$/i.test(name)) throw new Block("artifact-path", "Use a screenshot or text filename");
        const file = await open(await scoped(cwd, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Block("artifact-file", "Expected a regular file no larger than 8 MiB");
          bytes = Buffer.alloc(info.size);
          for (let at = 0; at < info.size;) {
            const { bytesRead } = await file.read(bytes, at, info.size - at, at);
            if (!bytesRead) throw new Block("artifact-file", "File changed while reading");
            at += bytesRead;
          }
        } finally { await file.close(); }
        await writeScoped(artifacts, name, bytes);
        const target = join(artifacts, name);
        saved.push(target);
        const ext = /\.(png|jpe?g|webp)$/i.exec(name)?.[1].toLowerCase();
        if (!ext || bytes.length > 2 * 1024 * 1024) return `Saved ${target}`;
        return { text: `Saved ${target}`, image: { mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`, data: bytes.toString("base64") } };
      }),
    );
  }
  return {
    tools,
    saved,
    /** Wait for every owned process; rethrow if one could not be confirmed stopped. */
    async close() {
      await Promise.allSettled(running);
      const box = await env?.catch(() => undefined);
      if (box) await Promise.all([rm(runtime, { recursive: true, force: true }), rm(box.tmp, { recursive: true, force: true })]);
      if (cleanupError) throw cleanupError;
    },
  };
}
