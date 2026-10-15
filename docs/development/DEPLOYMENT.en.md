# Deployment and Integration

English · [简体中文](DEPLOYMENT.zh-CN.md)

## Current Live Topology (Read-Only Audit, 2026-10-15)

Production and an isolated Preview already exist. This is a snapshot from the audit date, not evidence that the current local code is deployed and not authorization to change cloud or server state.

| Environment | Web / Worker | Origin | Tencent Compose / Git | Database |
| --- | --- | --- | --- | --- |
| Production | `https://tasklutein.xswt.fyi`; Worker `tasklutein` | `https://origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein`; `main` / `4b4d6e6`; Compose project `deploy`, 5 running containers | PostgreSQL healthy; volume `deploy_tasklutein_db` |
| Preview | `https://dev.preview.tasklutein.xswt.fyi`; Worker Preview name `dev` | `https://preview-origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein-preview`; `dev` / `a0e7910`; Compose project `tasklutein-preview`, 4 running containers; separate Tunnel project | PostgreSQL healthy; volume `tasklutein-preview_tasklutein_db` |

The environments use separate Docker networks, database volumes, and Tunnels; host ports bind to `127.0.0.1` only. The Cloudflare Workers Preview API currently lists deployment #3 as the latest deployment for Preview `dev` (`691758a8-4d02-489b-9cf5-bab3237895e4`; immutable URL: `https://691758a8.preview.tasklutein.xswt.fyi`). Read-only deployment details show its `ORIGIN_URL` is `https://preview-origin-tasklutein.xswt.fyi` and an `ORIGIN_GATEWAY_TOKEN` secret binding exists (name/type only; its value was not read). The stable Preview URL and this immutable URL currently serve the same JavaScript asset hash; the immutable URL returns health 200 and anonymous task API 401. The deployment metadata has no Git SHA, so its source commit is still unproven. Wrangler's Production deployment #5 is a separate record and cannot substitute for Preview version evidence.

With explicit Owner authorization, the `xswt.fyi` zone's `always_use_https` setting has been changed from `off` to `on`; SSL mode is `Full`. Read-only HEAD checks covered all nine hostnames in the Cloudflare DNS result (including `dev.preview.tasklutein.xswt.fyi`): HTTP requests returned 301 or 308, and HTTPS connections succeeded. Production and Preview Tasklutein `/api/health` return 200; both direct origin health requests remain 403. The only DNS-only hostname returns its own 308. The local Worker HTTP-to-HTTPS fallback remains undeployed. Cloudflare documents Always Use HTTPS as an edge redirect for all HTTP requests.

Baseline public checks: Preview `/api/health` returned 200; anonymous `/api/tasks` and `/mcp` returned 401; direct anonymous Preview API/MCP origin requests returned 403. Production `/api/health` returned 200 and its API origin returned 403 anonymously. A later authenticated smoke through the public Preview Worker completed one `[smoke-test]` API/MCP/PostgreSQL flow: the Web Token created a task, changed it to `in_progress`, wrote a user report, and read it back across API requests; remote MCP completed initialize, tools/list, `list_tasks`, and `add_report`; the Web Token read both `source=user` and `source=agent` reports. A SQL query scoped to that test ID confirmed the PostgreSQL task and report rows were committed. After API deletion, SQL confirmed the task/report rows were gone and the API returned 404 for task and report reads. A separate authenticated browser run created a task and changed its status, but the currently deployed Web sent a client-controlled `source` in the report request, which the API correctly rejected with 422; the test task was deleted and the count returned to zero. The local Web fix now sends only `content` and formats FastAPI validation errors, but has not been deployed. Browser Mock API checks also passed for the actual Preview assets/DOM at desktop and 390px, showing Agent attribution without overflow. Persistence after API/DB process restart remains unverified. No Production task or database data was written; the zone-level HTTPS redirect setting was changed with Owner authorization. Production and Preview token values were not compared, and database backup/restore was not verified.

## Data Flow and Boundaries

The browser and MCP clients use the Cloudflare Worker. It forwards API/MCP requests through Cloudflare Tunnel to Tencent Caddy, which routes them to FastAPI or Node MCP; those services access PostgreSQL.

- The Worker serves static Web assets and the public `/api/*` and `/mcp` ingress only. FastAPI owns business validation and task/report persistence; MCP tools call that API.
- Production and Preview have separate Worker runtime settings, Tunnels, Compose projects, and database volumes. Do not connect Preview data, ports, or secrets to Production.
- Gateway, Web, and Agent bearer secrets are independent. Keep secrets in runtime configuration, never Git, plain `wrangler.jsonc` variables, `VITE_*`, or logs.
- Remote HTTP MCP currently uses a stateless transport per POST with JSON responses. The lockfile resolves an MCP SDK whose highest supported protocol version is `2025-11-25`. OAuth, event resumption, and the newer `2026-07-28` transport metadata semantics are not implemented.

## Local Verification and Read-Only Preview Smoke

Run local checks from the Windows checkout:

```powershell
npm run check
& .\backend\.venv\Scripts\python.exe -m pytest -q
& .\backend\.venv\Scripts\ruff.exe check backend/app backend/tests
docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
```

`npm run build:worker` is a Wrangler dry run; it does not deploy. `npm run smoke:preview` sends unauthenticated, read-only public requests to check Preview health, anonymous rejection, and origin rejection. It does not write tasks and cannot prove real token authentication, database persistence, or MCP tool calls. Its default targets are `dev.preview.tasklutein.xswt.fyi` and `preview-origin-tasklutein.xswt.fyi`.

If the local Docker Engine is unavailable, Compose `config --quiet` validates only static configuration, not container startup or database connectivity. A real Preview write test needs an agreed test-data and cleanup procedure and must use Preview credentials only.

The planned authenticated API/MCP loop can be run in an approved environment with `npm run e2e:preview`. Provide `TASKLUTEIN_PREVIEW_WEB_TOKEN` and `TASKLUTEIN_PREVIEW_AGENT_TOKEN` securely in the current process; do not echo or save them. The script is pinned to `dev.preview.tasklutein.xswt.fyi`, requires distinct tokens, creates one uniquely tagged `[smoke-test]` task, verifies Web CRUD/user attribution and MCP Agent attribution, then deletes the task and confirms API reads return 404. If cleanup fails, it reports that condition; check for the unique tagged task before rerunning. This verifies the API/MCP loop, not browser DOM, mobile keyboard behavior, or persistence after a service restart. Never set these variables to Production credentials.

## Change and Release Rules

- `dev` is for daily development and Preview; `main` is the Production release branch. Current authorization covers local changes/checks and read-only inventory only. Commits, pushes, deployments, SSH changes, secret rotation, and Production writes still require separate explicit authorization.
- Existing server directories are already running. Do not clone them again, recreate Tunnels/Workers, reinitialize databases, or replay `migrations/0001_init.sql`. The Preview checkout has a local Mihomo Compose override; inspect the actual server configuration before using it, and do not copy older commands blindly.
- Any approved Preview update should record the local SHA and remote Preview checkout/Worker version first, verify that the Production target is unchanged, then update only the Preview Compose project. Rolling back application code does not roll back database schema.
- Production release requires separate approval, backup/restore evidence, and an explicit rollback point. Cloudflare WAF, rate limits, and Secret changes are runtime changes.
- A GitHub Release is not a Worker deployment. See [`RELEASE.md`](../../RELEASE.md) for release and rollback procedures.

## Not Yet Verified

- The local Preview Web report fix has not been deployed; after an authorized Preview update, verify real Web report submission, refresh readback, and PostgreSQL persistence. Remote MCP initialize/tools/list and a real tool call have passed.
- Preview/Production token cross-rejection and secret independence. Only Compose/volume/network topology was checked; Secret values were not read.
- Production backup existence and restore rehearsal; exact Worker deployment SHA; whether Preview Worker builds map to the expected Git commit.
- Cloudflare WAF/rate-limit configuration and full user-side browser, keyboard-open, and accessibility acceptance.
