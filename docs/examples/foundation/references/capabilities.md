# Capabilities

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

