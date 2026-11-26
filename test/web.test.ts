import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/runtime/config.ts";
import { loadWorkflows } from "../src/runtime/workflows.ts";
import type { Capabilities, Spec } from "../src/sdk/contract.ts";
import {
  createSafeFetcher,
  createWebTools,
  extractHtmlText,
  isBlockedIp,
  WEB_EVIDENCE_BANNER,
  type LookupAddress,
  type WebRequestFn,
} from "../src/web.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, FULL_CAPS, KINDS, repo, type Script } from "./fake.ts";

const FORK_CAPS: Capabilities = { ...FULL_CAPS, contextFork: true };

interface MockRoute {
  status: number;
  headers?: Record<string, string>;
  chunks?: (string | Buffer)[];
  delayMs?: number;
  onRequest?: (info: { url: URL; method: string; headers: Record<string, unknown>; body: string; servername?: string }) => void;
}

/**
 * Offline mock `request` that invokes `options.lookup` exactly as `node:http`/`node:https` does,
 * proving IP validation runs inside the connector's `lookup` callback before any response is served.
 */
function mockRequest(routes: Record<string, MockRoute> | ((url: URL) => MockRoute)): WebRequestFn {
  return (url, options, callback) => {
    const req = new EventEmitter() as ClientRequest & { destroyed?: boolean };
    let body = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    req.destroyed = false;
    req.write = ((chunk: string | Buffer) => { body += chunk.toString(); return true; }) as ClientRequest["write"];
    req.destroy = ((err?: Error) => {
      req.destroyed = true;
      if (timer) clearTimeout(timer);
      if (err) queueMicrotask(() => req.emit("error", err));
      return req;
    }) as ClientRequest["destroy"];
    req.end = (() => {
      const deliver = () => {
        if (req.destroyed) return;
        const route = typeof routes === "function" ? routes(url) : routes[url.href];
        if (!route) { req.emit("error", new Error(`No mock route for ${url.href}`)); return; }
        route.onRequest?.({
          url,
          method: String(options.method ?? "GET"),
          headers: (options.headers ?? {}) as Record<string, unknown>,
          body,
          servername: typeof options.servername === "string" ? options.servername : undefined,
        });
        const emitResponse = () => {
          if (req.destroyed) return;
          const res = new EventEmitter() as IncomingMessage & { destroyed?: boolean };
          res.statusCode = route.status;
          res.headers = route.headers ?? {};
          res.resume = () => res;
          res.destroy = (() => { res.destroyed = true; return res; }) as IncomingMessage["destroy"];
          callback(res);
          queueMicrotask(() => {
            for (const chunk of route.chunks ?? []) {
              if (res.destroyed || req.destroyed) return;
              res.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            if (!res.destroyed && !req.destroyed) res.emit("end");
          });
        };
        if (route.delayMs) {
          timer = setTimeout(emitResponse, route.delayMs);
        } else {
          queueMicrotask(emitResponse);
        }
      };

      if (options.lookup) {
        options.lookup(url.hostname, { all: true }, (err) => {
          if (req.destroyed) return;
          if (err) { req.emit("error", err); return; }
          deliver();
        });
      } else {
        deliver();
      }
      return req;
    }) as ClientRequest["end"];
    return req;
  };
}

const publicLookup = async (): Promise<readonly LookupAddress[]> => [{ address: "93.184.216.34", family: 4 }];

test("web: IP classification blocks private/loopback/metadata/CGNAT/ULA/zone/IPv4-mapped forms and allows public IPs", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254",
    "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.127.255.254",
    "0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::1", "[::1]", "::",
    "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "fe80::1%eth0", "[fe80::1%25eth0]",
    "::ffff:127.0.0.1", "[::ffff:169.254.169.254]", "::ffff:10.0.0.1",
    "::ffff:7f00:0001", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0000:0000:0000:0000:0000:ffff:c0a8:0101",
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIp(ip), true, `expected ${ip} to be blocked`);
  }

  const allowed = [
    "93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1",
    "2606:2800:220:1:248:1893:25c8:1946", "::ffff:93.184.216.34", "::ffff:5db8:d822",
  ];
  for (const ip of allowed) {
    assert.equal(isBlockedIp(ip), false, `expected ${ip} to be allowed`);
  }
});

test("web: safeFetch blocks SSRF inside lookup callback, IP literals, redirects to private IPs, and real loopback connect", async (t) => {
  const signal = AbortSignal.timeout(5_000);

  // 1. Mock lookup returning private/dual/hex-mapped IPs fails inside lookup before request serves anything.
  let served = 0;
  const req = mockRequest(() => ({ status: 200, headers: { "content-type": "text/plain" }, chunks: ["secret"], onRequest: () => { served++; } }));
  const dnsMap: Record<string, LookupAddress[]> = {
    "meta.test": [{ address: "169.254.169.254", family: 4 }],
    "dual.test": [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    "hexv6.test": [{ address: "::ffff:7f00:0001", family: 6 }],
    "ula.test": [{ address: "fd00::1", family: 6 }],
  };
  const fetcher = createSafeFetcher({
    request: req,
    lookup: async (host) => dnsMap[host] ?? [{ address: "93.184.216.34", family: 4 }],
  });

  for (const bad of [
    "http://meta.test/",
    "http://dual.test/",
    "http://hexv6.test/",
    "http://ula.test/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://localhost/admin",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(fetcher(bad, { signal }), /Refused|Unsupported|Invalid/, `should reject ${bad}`);
  }
  assert.equal(served, 0, "blocked requests must never reach the server");

  // 2. Redirect from public host to private IP is blocked on hop 2.
  const redirectFetcher = createSafeFetcher({
    request: mockRequest({
      "https://public.test/start": { status: 302, headers: { location: "http://meta.test/latest" } },
      "http://meta.test/latest": { status: 200, headers: { "content-type": "text/plain" }, chunks: ["leaked"] },
    }),
    lookup: async (host) => host === "meta.test" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }],
  });
  await assert.rejects(redirectFetcher("https://public.test/start", { signal }), /Refused private\/blocked IP/);

  // 3. Too many redirects (>5 hops) fails cleanly.
  const loopFetcher = createSafeFetcher({
    request: mockRequest((url) => {
      const n = Number(url.pathname.slice(1) || "0");
      return { status: 302, headers: { location: `https://public.test/${n + 1}` } };
    }),
    lookup: publicLookup,
  });
  await assert.rejects(loopFetcher("https://public.test/0", { signal }), /Too many redirects/);

  // 4. Real node:http server on 127.0.0.1 + default node:http.request with custom lookup returning 127.0.0.1.
  let realHits = 0;
  const server = createServer((_req, res) => { realHits++; res.end("never"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const realFetcher = createSafeFetcher({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await assert.rejects(realFetcher(`http://rebind.test:${port}/`, { signal }), /Refused private\/blocked IP 127\.0\.0\.1/);
  assert.equal(realHits, 0, "real node:http socket never connected to loopback");
});

test("web: timeout, 512 KiB download cap, HTML-to-text extraction, and binary MIME rejection", async () => {
  const signal = AbortSignal.timeout(5_000);

  // 1. HTML extraction + evidence framing + SNI preservation.
  let seenSni: string | undefined;
  const html = `<!doctype html><html><head><title>Docs &amp; Guide</title><style>.x{color:red}</style></head>
    <body><!-- hidden --><script>alert(1)</script><svg><path d="M0"/></svg>
    <h1>Heading</h1><p>Alpha &lt;Beta&gt; &#39;ok&#39;</p><div>Second line</div></body></html>`;
  const [_, webFetch] = createWebTools({
    request: mockRequest({
      "https://example.test/page": {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        chunks: [html],
        onRequest: ({ servername }) => { seenSni = servername; },
      },
      "https://example.test/big": {
        status: 200,
        headers: { "content-type": "text/plain" },
        chunks: [Buffer.alloc(300 * 1024, "a"), Buffer.alloc(300 * 1024, "b")],
      },
      "https://example.test/bin": {
        status: 200,
        headers: { "content-type": "application/pdf" },
        chunks: ["%PDF-1.7"],
      },
    }),
    lookup: publicLookup,
    env: {},
  });

  const fetched = await webFetch.run({ url: "https://example.test/page" }, signal) as string;
  assert.equal(seenSni, "example.test");
  assert.ok(fetched.startsWith(WEB_EVIDENCE_BANNER));
  assert.match(fetched, /"title":"Docs & Guide"/);
  assert.match(fetched, /"truncated":false/);
  assert.match(fetched, /Heading\n+Alpha <Beta> 'ok'\n+Second line/);
  assert.doesNotMatch(fetched, /alert\(1\)|color:red|hidden/);

  // 2. 512 KiB download cap sets truncated: true without buffering unbounded data.
  const big = await webFetch.run({ url: "https://example.test/big", maxChars: 1000 }, signal) as string;
  assert.match(big, /"truncated":true/);

  // 3. Binary MIME rejected.
  await assert.rejects(async () => webFetch.run({ url: "https://example.test/bin" }, signal), /Unsupported content type: application\/pdf/);

  // 4. Timeout enforced.
  const [, slowFetch] = createWebTools({
    request: mockRequest({
      "https://slow.test/": { status: 200, headers: { "content-type": "text/plain" }, chunks: ["late"], delayMs: 500 },
    }),
    lookup: publicLookup,
    timeoutMs: 40,
    env: {},
  });
  await assert.rejects(async () => slowFetch.run({ url: "https://slow.test/" }, signal), /timed out/i);

  // Direct HTML extractor unit check.
  const parsed = extractHtmlText("<title>  A &nbsp; B </title><noscript>no</noscript><p>Hi&#x21;</p>");
  assert.deepEqual(parsed, { title: "A B", text: "Hi!" });
});

test("web: search providers (Brave, Tavily, Exa), explicit provider pin, and graceful web-unconfigured", async () => {
  const signal = AbortSignal.timeout(5_000);
  const seen: { url: string; method: string; headers: Record<string, unknown>; body: string }[] = [];

  const req = mockRequest((url) => {
    if (url.hostname === "api.search.brave.com") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [JSON.stringify({ web: { results: [{ title: "Brave Hit", url: "https://brave.example/1", description: "Snippet B" }] } })],
        onRequest: (i) => seen.push({ url: i.url.href, method: i.method, headers: i.headers, body: i.body }),
      };
    }
    if (url.hostname === "api.tavily.com") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [JSON.stringify({ results: [{ title: "Tavily Hit", url: "https://tavily.example/1", content: "Snippet T" }] })],
        onRequest: (i) => seen.push({ url: i.url.href, method: i.method, headers: i.headers, body: i.body }),
      };
    }
    if (url.hostname === "api.exa.ai") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [JSON.stringify({ results: [{ title: "Exa Hit", url: "https://exa.example/1", text: "Snippet E" }] })],
        onRequest: (i) => seen.push({ url: i.url.href, method: i.method, headers: i.headers, body: i.body }),
      };
    }
    return { status: 200, headers: { "content-type": "text/plain" }, chunks: ["ok"] };
  });

  // No env key -> actionable web-unconfigured error, while web_fetch still works!
  const [unconfiguredSearch, zeroKeyFetch] = createWebTools({ request: req, lookup: publicLookup, env: {} });
  await assert.rejects(
    async () => unconfiguredSearch.run({ query: "pi-worq" }, signal),
    (err: unknown) => err instanceof Error && /BRAVE_API_KEY/.test(err.message) && /TAVILY_API_KEY/.test(err.message) && /EXA_API_KEY/.test(err.message) && /web_fetch/.test(err.message),
  );
  assert.match(await zeroKeyFetch.run({ url: "https://docs.example/readme" }, signal) as string, /ok/);

  // Brave (auto-selected first).
  const [braveSearch] = createWebTools({ request: req, lookup: publicLookup, env: { BRAVE_API_KEY: "b-key", TAVILY_API_KEY: "t-key" } });
  const braveOut = await braveSearch.run({ query: "node 22", count: 3 }, signal) as string;
  assert.ok(braveOut.startsWith(WEB_EVIDENCE_BANNER));
  assert.match(braveOut, /"provider": "brave"/);
  assert.match(braveOut, /Brave Hit/);
  assert.equal(seen.at(-1)!.headers["X-Subscription-Token"], "b-key");

  // Explicit provider override picks Tavily even when BRAVE_API_KEY is set.
  const [tavilySearch] = createWebTools({ request: req, lookup: publicLookup, env: { BRAVE_API_KEY: "b-key", TAVILY_API_KEY: "t-key" }, provider: "tavily" });
  const tavilyOut = await tavilySearch.run({ query: "node 22", count: 2 }, signal) as string;
  assert.match(tavilyOut, /"provider": "tavily"/);
  assert.match(tavilyOut, /Tavily Hit/);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { api_key: "t-key", query: "node 22", max_results: 2 });

  // Exa.
  const [exaSearch] = createWebTools({ request: req, lookup: publicLookup, env: { EXA_API_KEY: "e-key" } });
  const exaOut = await exaSearch.run({ query: "node 22" }, signal) as string;
  assert.match(exaOut, /"provider": "exa"/);
  assert.match(exaOut, /Exa Hit/);
  assert.equal(seen.at(-1)!.headers["x-api-key"], "e-key");
});

test("web: config web.provider, workflow web frontmatter validation, brainstorm tool exposure, and forked PQ fencing", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = await mkdtemp(join(tmpdir(), "worq-web-prof-"));
  t.after(() => rm(profile, { recursive: true, force: true }));

  // Config validation for web.provider.
  await writeFile(join(profile, "pi-worq.json"), JSON.stringify({ web: { provider: "exa" } }));
  assert.deepEqual(loadConfig(profile).web, { provider: "exa" });
  await writeFile(join(profile, "pi-worq.json"), JSON.stringify({ web: { provider: "invalid" } }));
  assert.throws(() => loadConfig(profile), /\/web\/provider/);

  // Workflow frontmatter validation for web.
  await mkdir(join(profile, "workflows", "bad-web"), { recursive: true });
  await writeFile(join(profile, "workflows", "bad-web", "SKILL.md"), "---\nname: bad-web\ndescription: Bad\naccess: read\nweb: maybe\n---\nBody.\n");
  const wf = loadWorkflows(profile);
  assert.match(wf.problems[0]?.message ?? "", /web must be true or false/);

  // Shipped brainstorm package exposes web_search + web_fetch to owner, fences them on forked PQ.
  let ownerTools: string[] = [];
  let pqSearchResult = "";
  let pqFetchResult = "";
  let ownerSearchErr = "";
  let ownerFetchOut = "";
  const seen: Spec[] = [];
  const scripts: Record<string, Script> = {
    "agent.brainstorm": async (turn) => {
      ownerTools = turn.spec.tools.map((x) => x.name);
      if (turn.text.includes('"task"')) {
        ownerSearchErr = await turn.tool("web_search", { query: "test" });
        ownerFetchOut = await turn.tool("web_fetch", { url: "https://docs.test/spec" });
        await turn.tool("delegate", { name: "facts", question: "Check app.py", why: "grounding", fork: true });
        return;
      }
      await turn.tool("submit", {
        summary: "Brainstormed with web + repo.",
        files: [{ path: "00-index.md", content: "# Brief\n" }],
      });
    },
    "subagent.facts": async (turn) => {
      pqSearchResult = await turn.tool("web_search", { query: "blocked" });
      pqFetchResult = await turn.tool("web_fetch", { url: "https://docs.test/spec" });
      await turn.tool("submit", { summary: "Basis: observed. app.py:1 prints hello" });
    },
  };

  const worq = new Worq({
    driver: fakeDriver(scripts, seen, FORK_CAPS, { snapshot: (s) => [{ role: "user", content: `hist:${s.name}` }] }),
    kinds: KINDS,
    config: config(),
    state,
    cwd: root,
    web: {
      env: {},
      lookup: publicLookup,
      request: mockRequest({
        "https://docs.test/spec": { status: 200, headers: { "content-type": "text/html" }, chunks: ["<title>Spec</title><p>Grounded fact</p>"] },
      }),
    },
    notify() {},
  });
  t.after(() => worq.shutdown());

  const agent = await worq.spawn("brainstorm", "Explore options", { title: "Explore options" });
  const deadline = Date.now() + 10_000;
  while (agent.state !== "parked" && !agent.ended && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(agent.state, "parked");
  assert.ok(ownerTools.includes("web_search") && ownerTools.includes("web_fetch"));
  assert.match(ownerSearchErr, /BRAVE_API_KEY/);
  assert.match(ownerFetchOut, /Grounded fact/);
  assert.match(pqSearchResult, /Disabled in a forked PQ/);
  assert.match(pqFetchResult, /Disabled in a forked PQ/);
});
