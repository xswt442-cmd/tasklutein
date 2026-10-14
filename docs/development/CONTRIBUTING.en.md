# Contributing and Verification

English · [简体中文](CONTRIBUTING.zh-CN.md)

## Git Workflow

Use `dev` for day-to-day development; `main` is the release branch. Merge features through PRs describing motivation, user impact, test evidence, deployment changes, and migration risks. Green CI does not mean deployed. Branch switches, commits, pushes, merges, resets, and deployments need explicit approval. Read root `AGENTS.md` and architecture docs first.

## TypeScript, Worker, and MCP

Requires Node.js 24+ and lockfile `package-lock.json`:

```sh
npm ci
npm run check
```

`npm run check` runs TypeScript, Vitest, stdio MCP handshake, bilingual docs, Vite Assets build, and `wrangler deploy --dry-run`; it **does not deploy cloud resources**. `test/edge.test.ts` covers gateway headers/auth; `test/mcp-http.test.ts` uses a real MCP HTTP client for handshake. Update tests and docs alongside tool-contract changes. Commit lockfile changes with dependency updates.

## FastAPI and Database

Requires Python 3.12+, an isolated environment, and `backend/requirements-dev.txt`. Run from the repository root:

```sh
python -m pytest -q
ruff check backend/app backend/tests
```

API tests use isolated SQLite; production uses PostgreSQL. Tests cover task CRUD, server-stamped report authorship, both access tokens, and gateway secret enforcement. SQLite success does not verify PostgreSQL migrations, Docker, Tunnel, HTTP MCP streaming, or a live deployment. After data exists, add versioned database migrations; never edit initial DDL expecting it to run again.

## Documentation and Security

Keep Chinese/English README, architecture, API, deployment, and contributing guides paired. **CHANGELOG.md is a single bilingual file**; `RELEASE.md` is a maintainer runbook, and `.github/release-notes/vX.Y.Z.md` is the user-facing bilingual release note. Configuration changes in FastAPI, Worker, and MCP require updates in both languages. Do not commit `.env`, `.dev.vars`, access tokens, private database records, request logs with Authorization headers, or personal machine configuration.

## Releases and Rollbacks

`.github/workflows/check.yml` verifies `dev`, `main`, and PR changes. After an explicitly pushed, version-matching Tag from `main`, `.github/workflows/release.yml` verifies the release and publishes **GitHub Release notes only, not infrastructure**. Cloudflare Worker deploys `wrangler.jsonc` and `apps/web/dist`; Tencent Docker runs FastAPI, PostgreSQL and remote MCP. Deploy and verify these layers separately, as described in [`RELEASE.md`](../../RELEASE.md). There is no automatic SSH/CD, migration runner or OAuth. Validate origin secrets, container health, backups and security groups before release; roll back application and database schema separately.
