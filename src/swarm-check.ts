import { Block } from "./contracts.ts";
import { git, gitRaw } from "./process.ts";

export interface SwarmCandidate {
  ref: string;
  branch: string;
  /** Exact commit SHA or branch ref to inspect. */
  commit?: string;
  /** Baseline commit the branch diverged from (defaults to git merge-base). */
  baseline?: string;
  state?: string;
  gatesPassed?: boolean;
}

export interface BranchCheck {
  ref: string;
  branch: string;
  sha?: string;
  baseline?: string;
  state?: string;
  gatesPassed?: boolean;
  filesChanged: string[];
  status: "clean" | "conflict" | "no-commit" | "error";
  conflictingFiles: string[];
  conflictsWith: string[];
  error?: string;
}

export interface PairwiseConflict {
  a: string;
  b: string;
  files: string[];
}

export interface SwarmCheckResult {
  targetRef: string;
  targetSha: string;
  clean: boolean;
  branches: BranchCheck[];
  pairwiseConflicts: PairwiseConflict[];
  sharedCleanFiles: { file: string; branches: string[] }[];
  mergeCommands: string[];
}

interface MergeTreeResult {
  clean: boolean;
  tree: string;
  conflicts: string[];
}

/**
 * 3-way in-core merge via `git merge-tree --write-tree` (Git >= 2.38).
 * Works on commit or tree OIDs when `--merge-base` is supplied; never mutates the checkout.
 */
async function mergeTree(
  root: string,
  base: string,
  ours: string,
  theirs: string,
  signal: AbortSignal,
): Promise<MergeTreeResult> {
  const res = await gitRaw(
    root, signal,
    "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z",
    `--merge-base=${base}`, ours, theirs,
  );
  if (res.code !== 0 && res.code !== 1) {
    const hint = /unknown option.*write-tree/i.test(res.stderr) ? " (requires Git >= 2.38)" : "";
    throw new Block("git", `git merge-tree failed${hint}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const parts = res.stdout.split("\0").filter(Boolean);
  const [tree = "", ...conflicts] = parts;
  if (!/^[0-9a-f]{40,64}$/i.test(tree)) {
    throw new Block("git", `Unexpected git merge-tree output: ${res.stdout.slice(0, 200)}`);
  }
  return { clean: res.code === 0, tree, conflicts };
}

async function changedFiles(root: string, base: string, commit: string, signal: AbortSignal): Promise<string[]> {
  const res = await gitRaw(root, signal, "diff", "--no-renames", "--name-only", "-z", base, commit);
  if (res.code !== 0) throw new Block("git", `git diff failed: ${res.stderr.trim()}`);
  return res.stdout.split("\0").filter(Boolean).sort();
}

export async function checkSwarm(
  root: string,
  candidates: readonly SwarmCandidate[],
  options: { target?: string; signal: AbortSignal },
): Promise<SwarmCheckResult> {
  const targetRef = options.target ?? "HEAD";
  const targetSha = await git(root, options.signal, "rev-parse", "--verify", `${targetRef}^{commit}`);
  let accTree = targetSha;

  const branches: BranchCheck[] = [];
  const fileOwners = new Map<string, string[]>();
  const resolved: { candidate: SwarmCandidate; sha: string; baseline: string; files: string[] }[] = [];

  // 1. Resolve SHAs, baselines, changed files, and run sequential accumulation onto target.
  for (const c of candidates) {
    const rev = c.commit ?? c.branch;
    const checkSha = await gitRaw(root, options.signal, "rev-parse", "--verify", `${rev}^{commit}`);
    if (checkSha.code !== 0) {
      branches.push({ ref: c.ref, branch: c.branch, state: c.state, gatesPassed: c.gatesPassed, filesChanged: [], status: "no-commit", conflictingFiles: [], conflictsWith: [], error: checkSha.stderr.trim() || "Commit not found" });
      continue;
    }
    const sha = checkSha.stdout.trim();
    const baseline = c.baseline ?? await git(root, options.signal, "merge-base", targetSha, sha);
    const files = await changedFiles(root, baseline, sha, options.signal);
    for (const file of files) {
      const owners = fileOwners.get(file) ?? [];
      owners.push(c.ref);
      fileOwners.set(file, owners);
    }
    resolved.push({ candidate: c, sha, baseline, files });

    if (!files.length) {
      branches.push({ ref: c.ref, branch: c.branch, sha, baseline, state: c.state, gatesPassed: c.gatesPassed, filesChanged: [], status: "clean", conflictingFiles: [], conflictsWith: [] });
      continue;
    }

    const merged = await mergeTree(root, baseline, accTree, sha, options.signal);
    if (merged.clean) {
      accTree = merged.tree;
      branches.push({ ref: c.ref, branch: c.branch, sha, baseline, state: c.state, gatesPassed: c.gatesPassed, filesChanged: files, status: "clean", conflictingFiles: [], conflictsWith: [] });
    } else {
      // Attribute conflicts against target and already-merged branches touching those files.
      const culprits = new Set<string>();
      for (const file of merged.conflicts) {
        const prior = (fileOwners.get(file) ?? []).filter((r) => r !== c.ref);
        if (prior.length) for (const r of prior) culprits.add(r);
        else culprits.add(targetRef);
      }
      branches.push({
        ref: c.ref, branch: c.branch, sha, baseline, state: c.state, gatesPassed: c.gatesPassed,
        filesChanged: files, status: "conflict", conflictingFiles: merged.conflicts, conflictsWith: [...culprits],
      });
    }
  }

  // 2. Pairwise exact check for any two branches touching at least one common file.
  const pairwiseConflicts: PairwiseConflict[] = [];
  const conflictedFiles = new Set<string>();
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      const bSet = new Set(b.files);
      if (!a.files.some((f) => bSet.has(f))) continue;
      const base = a.baseline === b.baseline ? a.baseline : await git(root, options.signal, "merge-base", a.sha, b.sha);
      const pair = await mergeTree(root, base, a.sha, b.sha, options.signal);
      if (!pair.clean) {
        pairwiseConflicts.push({ a: a.candidate.ref, b: b.candidate.ref, files: pair.conflicts });
        for (const f of pair.conflicts) conflictedFiles.add(f);
      }
    }
  }

  const sharedCleanFiles = [...fileOwners.entries()]
    .filter(([file, refs]) => refs.length > 1 && !conflictedFiles.has(file))
    .map(([file, refs]) => ({ file, branches: refs }));

  const clean = branches.length > 0 && branches.every((b) => b.status === "clean" && b.gatesPassed !== false);
  const mergeCommands = clean
    ? branches.filter((b) => b.sha && b.filesChanged.length > 0).map((b) => `git merge --no-ff ${b.sha} -m "Merge ${b.branch}"`)
    : [];

  return { targetRef, targetSha, clean, branches, pairwiseConflicts, sharedCleanFiles, mergeCommands };
}

export function formatSwarmCheck(result: SwarmCheckResult): string {
  const lines = [
    `Swarm merge-tree check against ${result.targetRef} (${result.targetSha.slice(0, 10)}): ${result.clean ? "CLEAN" : "BLOCKED"}`,
  ];
  for (const b of result.branches) {
    const gate = b.gatesPassed === undefined ? "" : b.gatesPassed ? " · gates pass" : " · gates FAIL";
    const sha = b.sha ? ` @ ${b.sha.slice(0, 10)}` : "";
    const detail = b.status === "conflict"
      ? ` — conflicts on ${b.conflictingFiles.join(", ")} (with ${b.conflictsWith.join(", ")})`
      : b.error ? ` — ${b.error}` : "";
    lines.push(`  [${b.status}] ${b.ref} (${b.branch}${sha}) · ${b.filesChanged.length} file(s)${gate}${detail}`);
  }
  if (result.pairwiseConflicts.length) {
    lines.push("Pairwise conflicts:");
    for (const p of result.pairwiseConflicts) lines.push(`  ${p.a} <-> ${p.b}: ${p.files.join(", ")}`);
  }
  if (result.sharedCleanFiles.length) {
    lines.push("Shared files (auto-merged cleanly; verify semantically):");
    for (const s of result.sharedCleanFiles) lines.push(`  ${s.file}: ${s.branches.join(", ")}`);
  }
  if (result.mergeCommands.length) {
    lines.push("Merge commands (run only after explicit merge authorization):");
    for (const cmd of result.mergeCommands) lines.push(`  ${cmd}`);
  }
  return lines.join("\n");
}
