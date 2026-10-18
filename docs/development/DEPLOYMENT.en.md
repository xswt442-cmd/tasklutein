# Deployment and Integration

English · [简体中文](DEPLOYMENT.zh-CN.md)

## Service Topology

Web/Worker and business services deploy independently. Cloudflare Worker serves React static assets and proxies `/api/*` and `/mcp` to Caddy over Cloudflare Tunnel. FastAPI owns business rules and PostgreSQL writes; Node MCP calls FastAPI through REST.

Production and Preview use separate Worker settings, Tunnels, Compose projects, networks, database volumes, and tokens. Host ports are restricted to `127.0.0.1` or Docker networks; PostgreSQL is not exposed publicly. The official site is [Tasklutein](https://tasklutein.xswt.fyi).

Configure secrets in Cloudflare Dashboard and the server runtime. `ORIGIN_URL` is the trusted Worker origin, `ORIGIN_GATEWAY_TOKEN` is a Worker secret, and the backend checks the matching `EDGE_GATEWAY_TOKEN`. Web and Agents use separate business bearer tokens. Do not put secret values in Git, frontend `VITE_*` variables, or logs.

## Local Checks and Preview Smoke

Run from the repository root:

```sh
npm ci
npm run check
python -m pip install -r apps/api/requirements-dev.txt
python -m pytest -q
ruff check apps/api/app apps/api/tests
docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
```

`npm run build:worker` is a Wrangler dry-run; `docker compose config --quiet` validates configuration only. Neither validates running production services.

`npm run smoke:preview` makes unauthenticated, read-only requests for Preview health, anonymous API rejection, and direct-origin rejection. With approval, `npm run e2e:preview` uses `TASKLUTEIN_PREVIEW_WEB_TOKEN` and `TASKLUTEIN_PREVIEW_AGENT_TOKEN` provided securely to the current process: it creates a uniquely tagged task, records user/agent reports through REST/MCP, reads them back, and removes the records. The script targets Preview only; never supply Production credentials. On failure, follow its cleanup guidance before rerunning.

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

Never run `alembic upgrade head` against an unversioned database that already contains the business tables: it would try to recreate them. Review and apply further migrations separately before updating the API. Do not reinitialize an existing volume or execute an unreviewed downgrade. Production database changes require separate authorization.

## Release, Backup and Recovery

- `dev` is for development/Preview and `main` for released source. Keep data, tokens, Worker origins, and Tunnel settings isolated by environment.
- `scripts/production-backup.sh` creates a logical backup, and `scripts/production-restore-check.sh` verifies recovery in an isolated temporary PostgreSQL instance. Run both as an authorized Docker operator on the target server; a local Docker run is not evidence of production recovery. Manage off-host backups, retention, and recurring recovery checks as separate operations.
- Cloudflare Worker uses `keep_vars` in `wrangler.jsonc` to preserve runtime bindings. The Production deployment workflow validates the gateway secret binding type and public HTTP boundaries against the environment configuration.
- Verify deployed API/MCP versions, PostgreSQL schema, service health, and backups independently. A GitHub Release or static page returning 200 does not mean all platform services have been deployed.

See the [release runbook](RELEASE.md) for approval, rollback, and per-service checks.
