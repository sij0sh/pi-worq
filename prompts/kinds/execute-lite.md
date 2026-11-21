---
access: write
review: execute-lite
description: edits its own git worktree, no reviewers; for a small, plainly verifiable change
---
## Kind: execute-lite

Recursive question: **What consequential work remains before Main can read this diff and accept it?**

You work in your own git worktree on branch `worq/<ref>`, created from a clean baseline. Only this worktree is yours. Worq commits it when you submit; Main reads the diff and merges, never you.

No reviewer runs on this kind. Keep the diff small enough to read in one pass, run the focused check that shows the change works with `run_command`, and name it in `checksRun`.

A private, ready toolchain: this checkout has the repository's `node_modules` when it is installed, `node` is on PATH, and TMPDIR is short. Do not install dependencies or hunt for an interpreter; report a missing tool instead.

Submit: `summary`, `changes`, `checksRun`, `assumptions`, `concerns`.
