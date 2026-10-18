# Contributing and Verification

English · [简体中文](CONTRIBUTING.zh-CN.md)

## Git Workflow

Use `dev` for day-to-day development; `main` is the release branch. Merge features through PRs describing motivation, user impact, test evidence, deployment changes, and migration risks. Green CI does not mean deployed. Branch switches, commits, pushes, merges, resets, and deployments need explicit approval. Read root `AGENTS.md` and architecture docs first.

## TypeScript, Worker, and MCP

Requires Node.js 24+, Python 3.12+, and `uv`. The JavaScript and Python lockfiles are `package-lock.json` and `uv.lock`. The browser workflow test launches a local FastAPI process and uses its own file-backed SQLite database. From the repository root:

```sh
npm ci
uv sync --locked
uv run --locked npm run check
```

`uv run` makes the project's Python environment available to the browser workflow tests. The deployment Docker image and current CI pipeline continue to install `apps/api/requirements*.txt`; keep their compatible constraints in sync with `pyproject.toml` when changing Python dependencies.

`npm run check` runs TypeScript, Vitest (including the UI against real FastAPI HTTP over isolated SQLite), stdio MCP handshake, bilingual docs, Vite Assets build, and `wrangler deploy --dry-run`; it **does not deploy cloud resources**. `test/edge.test.ts` covers gateway headers/auth; `test/mcp-http.test.ts` uses a real MCP HTTP client for tools and pagination. Update tests and docs alongside tool-contract changes. Commit lockfile changes with dependency updates.

## FastAPI and Database

The root `pyproject.toml` configures runtime and development dependencies for `uv`; `.python-version` selects Python 3.12. Run from the repository root:

```sh
uv sync --locked
uv run --locked python -m pytest -q
uv run --locked ruff check apps/api/app apps/api/tests
```

For a local FastAPI server, create ignored `apps/api/.env` from `apps/api/.env.example` with an isolated PostgreSQL `DATABASE_URL` and a development `EDGE_GATEWAY_TOKEN`. Initialize an **empty local database** with `uv run --env-file apps/api/.env alembic -c apps/api/alembic.ini upgrade head`, then run `uv run --env-file apps/api/.env uvicorn app.main:app --app-dir apps/api --host 127.0.0.1 --port 8000`. `psql` or DBeaver can inspect the same local database using its connection details. The local Vite proxy does not provide Cloudflare Access authentication; use the real Access-protected Preview for a manual browser login, and use the integration tests for isolated local API and MCP flows. Do not create shared development Web or Agent tokens. Do not migrate an existing SQL-bootstrap database as if it were empty.

API behavior tests use isolated SQLite; PostgreSQL migration tests create and clean tables in an explicitly named disposable `*_test` database. GitHub Actions provides a fresh PostgreSQL 17 service and requires these integration tests to run. A local Postgres test database is opt-in:

```powershell
$env:TASKLUTEIN_TEST_DATABASE_URL = 'postgresql+psycopg://tasklutein_test:<local-test-password>@127.0.0.1:5432/tasklutein_test'
$env:TASKLUTEIN_TEST_DATABASE_NAME = 'tasklutein_test'
$env:TASKLUTEIN_ALLOW_POSTGRES_TEST_RESET = '1'
python -m pytest -q
```

The fixture refuses to run unless its connection names the same local `*_test` database and explicit reset permission is set. It drops the Tasklutein tables from that database. Never point it at Production or Preview. API tests cover user and Agent authentication, workspace isolation, report attribution, key revocation, gateway enforcement, Origin checks, filtering, pagination, and overview totals. PostgreSQL tests verify user/workspace uniqueness under concurrent bootstrap, Alembic upgrades, controlled legacy-task assignment with task/report preservation, scoped API writes, and Agent-key revocation. SQLite success does not verify Docker, Tunnel, or a live deployment.

Alembic baseline: a blank PostgreSQL database runs `alembic upgrade head`. A database created by the existing `apps/api/migrations/0001_init.sql` must be inspected and compared with `0001_baseline` before an operator runs `alembic stamp 0001_baseline`. For an existing shared workspace, apply `0002_identity_workspace`, bootstrap the explicitly selected owner through Cloudflare Access, then apply `0003_task_workspace_required` with the migration's required owner identity and confirmation environment values. Do not stamp an unverified database or run migrations automatically at application startup.

## Documentation and Security

Keep Chinese/English README, architecture, API, deployment, and contributing guides paired. **CHANGELOG.md is a single bilingual file**; `docs/development/RELEASE.md` is the maintainer runbook; GitHub Release notes are automatically generated from the tagged version section in `CHANGELOG.md`. Configuration changes in FastAPI, Worker, and MCP require updates in both languages. Do not commit `.env`, `.dev.vars`, access tokens, private database records, request logs with Authorization headers, or personal machine configuration.

## Releases and Rollbacks

`.github/workflows/check.yml` verifies `dev`, `main`, and PR changes. After an explicitly pushed, version-matching Tag from `main`, `.github/workflows/release.yml` verifies the release and publishes **GitHub Release notes only, not infrastructure**. Cloudflare Worker deploys `wrangler.jsonc` and `apps/web/dist`; Tencent Docker runs FastAPI, PostgreSQL and remote MCP. Deploy and verify these layers separately, as described in [`RELEASE.md`](RELEASE.md). There is no automatic SSH/CD, migration runner or OAuth. Validate origin secrets, container health, backups and security groups before release; roll back application and database schema separately.
