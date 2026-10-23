# Deployment and Integration

English · [简体中文](DEPLOYMENT.zh-CN.md)

## Service Topology

Web/Worker and business services deploy independently. Bind two hostnames to the Worker: the Web host serves React static assets and `/api/*`, while the MCP host accepts only `/mcp`. The Worker routes both services to Caddy over Cloudflare Tunnel. FastAPI owns business rules and PostgreSQL writes; Node MCP calls FastAPI through REST.

Production and Preview use separate Worker settings, Tunnels, Compose projects, networks, database volumes, and gateway secrets. Host ports are restricted to `127.0.0.1` or Docker networks; PostgreSQL is not exposed publicly. The official site is [Tasklutein](https://tasklutein.xswt.fyi).

Create a Cloudflare Access self-hosted application for the Web hostname's `/api/*` path. Enable One-time PIN and an Allow policy limited to invited email addresses; a more-specific `/api/health` application may allow public health checks. The Web root serves the public static frontend, where guests can only browse a non-interactive preview; `GET /api/session/login` returns the browser to the home page after Access authentication. Configure the Worker routes for both hostnames. Cloudflare manages Production `WEB_HOST`, `MCP_HOST`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ORIGIN_URL`; `previews.vars` in `wrangler.jsonc` supplies isolated branch Preview values. Store the Preview `ORIGIN_GATEWAY_TOKEN` in the Previews Base secret. Set the same gateway token as API and MCP `EDGE_GATEWAY_TOKEN`. Set `WEB_ORIGINS` to the exact Web origin. Keep the MCP hostname outside the browser Access application: the Worker accepts only `/mcp` there, requires a personal Agent key, and rejects all other paths. Configure a Cloudflare rate-limit rule for the MCP hostname and `/mcp` before exposing it to remote clients.

Do not place gateway secrets or Agent keys in Git, frontend `VITE_*` variables, or logs. Each user creates their own Agent key in Settings; the MCP service does not use a shared Agent credential.

## Local Checks and Preview Smoke

Run from the repository root:

```sh
npm ci
uv sync --locked
uv run --locked npm run check
uv run --locked python -m pytest -q
uv run --locked ruff check apps/api/app apps/api/tests
docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
```

`npm run build:worker` is a Wrangler dry-run; `docker compose config --quiet` validates configuration only. Neither validates running production services.

Run `npx wrangler preview --name dev` to update the Web Preview and `npx wrangler preview --name mcp` for its dedicated MCP Preview. Both use the isolated `previews.vars` values in `wrangler.jsonc`; do not run Production `wrangler deploy` against these hostnames. `npm run smoke:preview` checks the public frontend and health endpoint, rejects unauthenticated API/MCP requests, and verifies origin rejection. Set `TASKLUTEIN_PREVIEW_MCP_URL` to the dedicated MCP Preview hostname. After explicit Preview authorization and a successful One-time PIN login, `npm run e2e:preview` uses `TASKLUTEIN_PREVIEW_ACCESS_COOKIE`, `TASKLUTEIN_PREVIEW_MCP_URL`, and a personal `TASKLUTEIN_PREVIEW_AGENT_KEY` from Settings. It creates a uniquely tagged task, records user/Agent reports through REST/MCP, reads them back, and removes the task. These values must remain outside files and logs. The script targets Preview only; never supply Production credentials. On failure, follow its cleanup guidance before rerunning.

## PostgreSQL Baseline and Migrations

Docker Compose initializes a new database volume from `apps/api/migrations/0001_init.sql`; that schema corresponds to Alembic revision `0001_baseline`. Application startup does not run migrations.

- **Existing databases with business tables**: verify the environment, volume, backup and restore procedure; compare tables, columns, constraints, foreign keys, defaults and indexes to the baseline. With approval, run:

  ```sh
  docker compose -f deploy/compose.yml exec -T api alembic stamp 0001_baseline
  ```

- **Empty databases without business tables** (and without Compose initialization): after verification, run:

  ```sh
  docker compose -f deploy/compose.yml exec -T api alembic upgrade head
  ```

Never run `alembic upgrade head` against an unversioned database that already contains the business tables: it would try to recreate them. Review and apply further migrations separately before updating the API. Do not reinitialize an existing volume or execute an unreviewed downgrade.

For the M1.5 workspace migration, first bring a verified existing database to `0002_identity_workspace`:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env exec -T api alembic upgrade 0002_identity_workspace
```

Deploy the compatible API and let the intended legacy owner sign in through Cloudflare Access so that `/api/session/bootstrap` creates their user and workspace. If unassigned legacy tasks remain, explicitly provide that user's exact Access issuer, subject, and verified email when applying `0003_task_workspace_required`. This migration assigns every unowned task and its existing reports to that one workspace, preserves record IDs and content, and refuses to continue if the identity does not match an enabled user with a workspace. The confirmation value is `assign-existing-tasks`.

In a Bash session, enter these values interactively, then run the migration and clear them:

```sh
read -r -p 'Legacy owner Access issuer: ' TASKLUTEIN_LEGACY_OWNER_ISSUER
read -r -p 'Legacy owner Access subject: ' TASKLUTEIN_LEGACY_OWNER_SUBJECT
read -r -p 'Legacy owner verified email: ' TASKLUTEIN_LEGACY_OWNER_EMAIL
export TASKLUTEIN_LEGACY_OWNER_ISSUER TASKLUTEIN_LEGACY_OWNER_SUBJECT TASKLUTEIN_LEGACY_OWNER_EMAIL
export TASKLUTEIN_LEGACY_TASKS_CONFIRM=assign-existing-tasks
docker compose -f deploy/compose.yml --env-file deploy/.env exec \
  -e TASKLUTEIN_LEGACY_OWNER_ISSUER -e TASKLUTEIN_LEGACY_OWNER_SUBJECT \
  -e TASKLUTEIN_LEGACY_OWNER_EMAIL -e TASKLUTEIN_LEGACY_TASKS_CONFIRM \
  -T api alembic upgrade 0003_task_workspace_required
unset TASKLUTEIN_LEGACY_OWNER_ISSUER TASKLUTEIN_LEGACY_OWNER_SUBJECT \
  TASKLUTEIN_LEGACY_OWNER_EMAIL TASKLUTEIN_LEGACY_TASKS_CONFIRM
```

Verify the task and report counts and IDs before routing the second invited user to the application. A database with no unassigned tasks can apply `0003_task_workspace_required` without the legacy-owner values. Downgrading to `0001_baseline` is blocked because that schema has no workspace isolation; application rollback must retain workspace-scoped authorization. Production migration and deployment require separate authorization.

After applying `0003_task_workspace_required` and verifying the backup and recovery path, build the API image that contains the target migration, then apply `0004_task_history` and update the API/MCP services:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env build api mcp
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm --no-deps api alembic upgrade 0004_task_history
docker compose -f deploy/compose.yml --env-file deploy/.env up -d api mcp
```

`0004_task_history` adds a nullable task archive timestamp and creates the activity table. Existing tasks remain current, and the migration does not fabricate historical activity. The migration does not downgrade automatically. After the first archive, a rollback version must continue to filter archived tasks; do not use a downgrade or clear business history to restore an older version.

When upgrading a deployed environment, back it up and verify the target first, build API/MCP images containing the current migrations, apply them, and update only those services:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env build api mcp
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm --no-deps api alembic upgrade head
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --no-deps api mcp
```

`0005_report_comments` adds report comments. `0006_agent_token_hard_delete` permits physical Agent-key deletion while preserving history and clearing its key references.

## Release, Backup and Recovery

- `dev` is for development/Preview and `main` for released source. Keep data, tokens, Worker origins, and Tunnel settings isolated by environment.
- `scripts/production-backup.sh` creates a logical backup, and `scripts/production-restore-check.sh` verifies recovery in an isolated temporary PostgreSQL instance. Run both as an authorized Docker operator on the target server; a local Docker run is not evidence of production recovery. Manage off-host backups, retention, and recurring recovery checks as separate operations.
- Cloudflare Worker uses `keep_vars` in `wrangler.jsonc` to preserve runtime bindings. The Production deployment workflow validates the gateway secret binding type and public HTTP boundaries against the environment configuration.
- Verify deployed API/MCP versions, PostgreSQL schema, service health, and backups independently. A GitHub Release or static page returning 200 does not mean all platform services have been deployed.

See the [release runbook](RELEASE.md) for approval, rollback, and per-service checks.
