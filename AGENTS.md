# Tasklutein Agent Guidelines

## Architecture and boundaries

- Tasklutein uses React/Vite, a Cloudflare Worker, FastAPI, PostgreSQL, and MCP services deployed with Docker. Inspect the current code and relevant documentation before modifying or describing behavior.
- The Cloudflare Worker serves static assets and acts as the public HTTP gateway for `/api/*` and `/mcp`. FastAPI owns business validation, task and report persistence, and database writes. MCP tools use the REST API rather than accessing PostgreSQL directly.
- Cloudflare Access users receive a personal workspace and may create team workspaces with `owner` and `member` roles. There are no finer-grained roles. Browser requests select a joined workspace with `X-Tasklutein-Workspace-ID`; FastAPI checks membership on every request and defaults to the personal workspace when the header is absent. Agent keys are bound to one workspace and remain valid only while their creator is a member. FastAPI determines report attribution from the authenticated caller; an Agent report is not independent proof that a task is complete.
- Reports, comments, reviews, and activities retain links to the verified user and, while it exists, the Agent key. Permanently deleting a key clears its history references while preserving those records; the deleted key name can no longer be resolved. Otherwise, `actor_name` is resolved from the current email or key name when read; changing either can change older records' displayed name. The system does not store a name snapshot for each event.
- Keep gateway credentials, bearer tokens, database contents, and other secrets out of Git, logs, frontend `VITE_*` values, test snapshots, and public documentation.

## Documentation and reviews

- Read the repository-local [.github/engineering/ENGINEERING_STANDARD.md](.github/engineering/ENGINEERING_STANDARD.md) for documentation, categorized changelog, pull request, and release conventions; this project's verified code and specific rules remain authoritative.

- Tracked files must be portable and describe current behavior, public interfaces, actual limitations, and repeatable operations. Do not include personal paths, machine names, private SSH aliases, local network settings, one-off deployment records, debugging history, pending acceptance, or development plans.
- READMEs are user-facing. Update the authoritative section of a document rather than appending a development diary. Comments should explain constraints that still apply to the current code.
- Keep `README.md` and `README.en.md` consistent. Keep paired technical guides consistent across languages.
- `CHANGELOG.md` is the sole source for release-change text. GitHub Release notes are generated from the corresponding tagged version; do not create separately maintained release-note files.
- PR descriptions must include matching Simplified Chinese and English sections describing only completed changes and checks that actually passed. Use Issues for separate future work.
- Consult [Architecture](docs/development/ARCHITECTURE.en.md), [API](docs/development/API.en.md), [Contributing](docs/development/CONTRIBUTING.en.md), and the [Release runbook](docs/development/RELEASE.md) when relevant.

## Verification and permissions

- Run checks appropriate to the changes. Project verification includes `npm run check`, `python -m pytest -q`, and `ruff check apps/api/app apps/api/tests`. Worker dry-runs and SQLite tests do not validate a running production deployment.
- Keep `icons/` intact. `testplace/` is ignored local scratch space and must not be committed.
- Commit, push, branch changes, resets, tags, releases, deployments, server modifications, secret rotation, and production data operations require explicit authorization within the current task. Do not infer continuing authorization from previous work.
