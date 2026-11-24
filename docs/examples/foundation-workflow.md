---
access: read
description: Audit the project foundation and report the failures it leaves open; writes nothing
reviewers: plan
---

# Objective

Audit this repository's project foundation — the guarantees that developing, deploying, operating and evolving it depend on — and report what is missing, or present but not working.

Derived from the `foundation` skill (VERSION 0.0.1). This workflow runs unattended: it never interviews the user, never applies changes and never writes project files.

# Workflow

1. **Classify.** Set `kind`: `greenfield` (little or no code or history) or `brownfield`. Set `maturity`: `prototype`, `mvp` or `production`, by the consequences of failure, not by size. `mode` is always `audit`: nothing is applied in this run. `.git` is not readable here, so judge history from what is tracked: manifests, CI, migrations, ADRs, docs and conventions that only accrue over time.

2. **Discover.** List the tree and read the manifests, task definitions, CI config, docs and infrastructure you find. For every task the project defines (`setup`, `build`, `test`, `lint`, `check`, `verify`, `dev`, `release`, `deploy`), note the command it actually runs; a task that only echoes or delegates nowhere establishes nothing.

3. **Interview no one.** Answer these from the repository instead of asking: what is being built, who operates it, what it must never do, which costs, approvals and compliance limits apply, what must not change. Record each answer you inferred rather than observed under `assumptions`, with the evidence that drove it and the condition that would reverse it. Do not call `ask_main`.

4. **Classify every capability** in the table below. Levels, from weakest to strongest: `none` (outcome absent), `detected` (a file or task exists for it), `configured` (that file or task carries the setting the outcome needs), `enforced` (named wiring runs it: a CI job, task, hook or declared boundary). `n/a` only where the capability genuinely does not apply, with the reason. Never claim more than the evidence shows.

5. **Order the gaps** by the failure each leaves open and what closing it costs. Prefer what the project already uses, and give the smallest change that closes the gap. Name, for each gap, what would detect the failure next time — a fix nobody checks is not a fix.

6. **Close.** Answer the recursive question with evidence, cite `path:line` for every material claim, and list what you could not examine. You cannot run commands: report release, deploy and provisioning steps rather than attempting them, and never suggest an installer or remote system this run would need.

## Capabilities

| id | outcome | look for |
|---|---|---|
| runtime-versions | Runtime and tool versions pinned in a committed config | mise.toml, .tool-versions, .nvmrc, .python-version, rust-toolchain.toml, flake.nix, .devcontainer |
| lockfiles | Dependency lockfiles committed | package-lock.json, pnpm-lock.yaml, uv.lock, poetry.lock, go.sum, Cargo.lock, mise.lock |
| one-command-setup | One command installs tools and deps and starts local dev; README steps match config | mise.toml, Makefile, justfile, Taskfile.yml, compose.yaml, README setup section |
| tests-lint | Automated tests and linting runnable locally | tests, test, __tests__, spec, eslint/biome/ruff/golangci config, pre-commit |
| ci-checks | CI runs the same checks on every pull request | .github/workflows, .gitlab-ci.yml, .circleci, azure-pipelines, Jenkinsfile |
| dependency-updates | Automated dependency and tool update PRs | renovate.json, .renovaterc, .github/dependabot.yml |
| architecture-doc | Architecture overview documented, diagram as code | docs/architecture*, ARCHITECTURE.md, *.mmd, *.puml, *.dsl |
| architecture-boundaries | Declared module boundaries enforced by an ecosystem tool wired into a task or CI step | .importlinter, .dependency-cruiser.*, *ArchTest*, *ArchitectureTest*, openapi/schema |
| adrs | Important decisions recorded as ADRs | docs/adr/, docs/decisions/, adr/, doc/adr/ |
| db-migrations | Database schema changes versioned as migrations | */migrations/, prisma/schema.prisma, alembic.ini, flyway.conf, atlas.hcl, db/migrate |
| secrets-excluded | Secrets kept out of Git; .env.example documents variables | .gitignore, .env.example, .sops.yaml, .gitleaks.toml |
| deployment-doc | Deployment process documented, and automated where it exists | docs/deploy*, DEPLOY*.md, .github/workflows/deploy*, Procfile, fly.toml, render.yaml |
| logging-health | Structured logging and a health check | logger setup, structured log config, health or readiness endpoint |
| declarative-infra | Infrastructure managed declaratively where infrastructure exists | *.tf, *.tofu, Pulumi.yaml, cdk.json, Chart.yaml, kustomization.yaml |

`logging-health` has no reliable file evidence: judge it from the code that emits logs and answers health checks, and say what would settle it where the code is inconclusive.

# Recursive question

What failure could still occur in developing, deploying, operating or evolving this project, that its foundation does not address?

# Completion

Submit a report with:

- `summary`: the worst open failure first, then the headline state of the foundation. No more than a short paragraph.
- `criteria`: checkable statements that would make this report trustworthy — every level backed by a citation, every gap naming the failure it leaves open and its smallest fix, every inferred user answer in `assumptions`.
- `decisions`: the consequential judgments (`kind`, `maturity`, and any level that is genuinely arguable) with basis, the serious alternative, the tradeoff and the condition under which to revisit it.
- `assumptions`: every user-owned answer you inferred, with evidence and reversal condition.
- `document`: the audit itself — one row per capability with its level, its evidence and the gap, then the ordered gap list with the smallest fix and the detection it would add.

This run applies nothing. Recommend changes; leave applying them to a separate, approved execution.
