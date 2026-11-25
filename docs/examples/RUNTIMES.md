# Worq Runtime Hints

Copy to `<agentDir>/worq/RUNTIMES.md` (e.g. `~/.pi/agent/worq/RUNTIMES.md`). Edits apply on the next spawn; running agents keep theirs.

Advisory defaults per role. Explicit launch fields (`worq_spawn`, `/worq`, `worq spawn`) always win.
Blank or `-` inherits: Main for top-level agents, the owning agent for children (`pq`, `review`, `edit`).
`<=level` caps the inherited thinking level and never raises it; `level` sets it. Unsupported levels snap down; harnesses without level control ignore thinking.
`max-turns` / `max-minutes` override workflow frontmatter, clamped by `pi-worq.json` limits.

| role | sdk | model | thinking | max-turns | max-minutes |
| --- | --- | --- | --- | --- | --- |
| * | - | - | - | - | - |
| scout | - | - | <=low | 16 | 5 |
| pq | - | - | <=medium | 14 | 5 |
| plan | - | - | <=high | 50 | 20 |
| execute | - | - | <=high | 80 | 30 |
| review | - | - | <=medium | 30 | 10 |
| plan.pq | - | - | <=medium | 12 | 4 |
| execute.review | - | - | <=high | 30 | 10 |
| edit | - | - | <=medium | 20 | 10 |

## Roles

- Top-level: `*` → `<kind>`.
- PQ: `*` → `pq` → `<kind>.pq` → `<kind>.pq.<name>`.
- Review: `*` → `review` → `<kind>.review`.
- Edit worker (`EDIT.md`): `*` → `edit` → `<kind>.edit` → `<kind>.edit.<name>`.

Cells merge broad → specific, per field.

## Notes

- Faster child model: set `model` (e.g. `openai-codex/gpt-5.4-mini`), optionally `sdk: pi`. An unavailable hinted model warns once and falls back.
- Forked children (`fork: true`) keep the parent's exact model and thinking so the prompt cache hits; their runtime hints are ignored. A hint selecting a different model switches the child to a fresh session instead.
- Prose, headings, HTML comments and fenced code blocks outside the table are ignored.
