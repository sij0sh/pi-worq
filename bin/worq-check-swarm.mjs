#!/usr/bin/env node
// Check whether a set of worq/* branches merge cleanly onto a target commit using `git merge-tree --write-tree`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/process.ts";
import { checkSwarm, formatSwarmCheck } from "../src/swarm-check.ts";
import { statePath } from "../src/platform.mjs";

const usage = `Usage: node bin/worq-check-swarm.mjs [--base HEAD] [--group <id>] [--json] [branch-or-ref ...]`;

function readRecord(ref) {
  try { return JSON.parse(readFileSync(join(statePath(), ref, "record.json"), "utf8")); }
  catch { return undefined; }
}

async function main(argv) {
  let target = "HEAD";
  let group;
  let asJson = false;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") { console.log(usage); return; }
    if (arg === "--json") { asJson = true; continue; }
    if (arg === "--base") { target = argv[++i]; continue; }
    if (arg === "--group") { group = argv[++i]; continue; }
    inputs.push(arg);
  }
  const signal = AbortSignal.timeout(30_000);
  const root = await git(process.cwd(), signal, "rev-parse", "--show-toplevel");

  let branches = inputs.map((x) => x.startsWith("worq/") ? x : `worq/${x}`);
  if (!branches.length) {
    const raw = await git(root, signal, "for-each-ref", "--format=%(refname:short)", "refs/heads/worq");
    branches = raw.split("\n").filter(Boolean);
  }

  const candidates = branches.flatMap((branch) => {
    const ref = branch.replace(/^worq\//, "");
    const rec = readRecord(ref);
    if (group && rec?.group !== group) return [];
    const gates = Array.isArray(rec?.gates) ? rec.gates : [];
    return [{
      ref,
      branch,
      commit: rec?.candidate ?? branch,
      baseline: rec?.baseline,
      state: rec?.state,
      gatesPassed: gates.length ? gates.every((g) => g.passed) : undefined,
    }];
  });

  if (!candidates.length) {
    console.error("worq-check-swarm: no matching worq/* branches found");
    process.exit(2);
  }

  const result = await checkSwarm(root, candidates, { target, signal });
  console.log(asJson ? JSON.stringify(result, null, 2) : formatSwarmCheck(result));
  process.exit(result.clean ? 0 : 1);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`worq-check-swarm: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
