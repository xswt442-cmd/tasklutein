# Deployment and Integration

English · [简体中文](DEPLOYMENT.zh-CN.md)

## Current Live Topology (Read-Only Audit, 2026-10-15)

Production and an isolated Preview already exist. This is a snapshot from 2026-10-15. For this run, the Owner explicitly authorized pushing `dev` and deploying Preview; the Production app and custom site domain were not changed.

| Environment | Web / Worker | Origin | Tencent Compose / Git | Database |
| --- | --- | --- | --- | --- |
| Production | `https://tasklutein.xswt.fyi`; Worker `tasklutein` | `https://origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein`; `main` / `4b4d6e6`; Compose project `deploy`, 5 running containers | PostgreSQL healthy; volume `deploy_tasklutein_db` |
| Preview | `https://dev.preview.tasklutein.xswt.fyi`; Worker Preview name `dev` | `https://preview-origin-tasklutein.xswt.fyi` | Worker tag `e1aa382`; VPS API/MCP checkout `dev` / `b9bcd83`; Compose project `tasklutein-preview`, 4 running containers; separate Tunnel project | PostgreSQL healthy; volume `tasklutein-preview_tasklutein_db` |

The environments use separate Docker networks, database volumes, and Tunnels; host ports bind to `127.0.0.1` only. The Cloudflare Workers Preview API lists deployment #6 as latest for Preview `dev` (`edb4957f-ed72-4f5c-9200-22b571da642f`; immutable URL: `https://edb4957f.preview.tasklutein.xswt.fyi`). Its deployment tag is the full commit SHA `e1aa3822054e9fde2c41d3cc5af1935ff7eda721`. The stable and immutable Preview URLs serve `/assets/index-Q95TUzoz.js`; health is 200 and anonymous task API is 401. Deployment configuration has `ORIGIN_URL=https://preview-origin-tasklutein.xswt.fyi` and an `ORIGIN_GATEWAY_TOKEN` secret binding (name/type only; value not read). The Production Worker remains at its separate deployment #5 and was not updated.

With explicit Owner authorization, the `xswt.fyi` zone's `always_use_https` setting was changed from `off` to `on`; SSL mode is `Full`. Read-only HEAD checks covered all nine hostnames in the Cloudflare DNS result (including `dev.preview.tasklutein.xswt.fyi`): HTTP requests returned 301 or 308, and HTTPS connections succeeded. Production and Preview Tasklutein `/api/health` return 200; both direct origin health requests remain 403. The only DNS-only hostname returns its own 308. The Worker HTTP-to-HTTPS fallback is also deployed in Preview #5.

Baseline public checks: Preview `/api/health` returned 200; anonymous `/api/tasks` and `/mcp` returned 401; direct anonymous Preview API/MCP origin requests returned 403. Production `/api/health` returned 200 and its API origin returned 403 anonymously. A real HTTPS browser created a tagged task and a `source=user` report; remote MCP `list_tasks` found that same task and added a `source=agent` report. Browser refresh displayed the task and both reports; Web API reads returned 200, and Preview PostgreSQL contained that task and both reports. Restarting Preview `api` and `mcp` containers preserved the records across MCP, SQL, and browser reads; the database container was not restarted. The task was then deleted through the UI, and SQL confirmed zero remaining task/report rows. Preview Worker #6 carries the connection-status fix. Playwright checked the real Preview at 360/390/430px with no horizontal overflow and a 44px minimum button height; the status displayed “已连接”. All five `npm run smoke:preview` checks passed. A sanitized server-side comparison confirmed the Web, Agent, gateway, and Tunnel secrets met strength requirements, were pairwise distinct per environment, and differed between Preview and Production; MCP/API Agent and gateway values matched within each environment. No secret values were printed. A Preview Web token sent to Production API for a nonexistent task ID returned 401; no Production task data was read or written. Database-container restart, backup recovery, and reverse rejection of the Production token by Preview remain unverified. The Production Worker/app and custom site domain were not changed; zone-level HTTPS changed with Owner authorization. The Production token was not read.

## Data Flow and Boundaries

Playwright intercepted one `/api/tasks` request on the real Preview page and returned 503 locally (no server change); the UI showed its unavailable state and retry guidance. After removing the interception, reload restored “已连接”. Narrow viewport checks at 360/390/430px found no horizontal overflow and a 44px minimum button height; they do not replace real-device keyboard or manual accessibility checks.

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

- `dev` is for daily development and Preview; `main` is the Production release branch. For this run, the Owner explicitly authorized the commit, `dev` push, Preview Worker deployment, Preview E2E writes, and cleanup. No Production Worker or custom site domain was changed. Future Production releases, server configuration/key changes, or Production data writes need authorization scoped to those actions.
- Existing server directories are already running. Do not clone them again, recreate Tunnels/Workers, reinitialize databases, or replay `migrations/0001_init.sql`. The Preview checkout has a local Mihomo Compose override; inspect the actual server configuration before using it, and do not copy older commands blindly.
- Any approved Preview update should record the local SHA and remote Preview checkout/Worker version first, verify that the Production target is unchanged, then update only the Preview Compose project. Rolling back application code does not roll back database schema.
- Production release requires separate approval, backup/restore evidence, and an explicit rollback point. Cloudflare WAF, rate limits, and Secret changes are runtime changes.
- A GitHub Release is not a Worker deployment. See [`RELEASE.md`](../../RELEASE.md) for release and rollback procedures.

## Not Yet Verified

- Persistence after a database-container restart remains untested; records survived Preview API/MCP container restarts and PostgreSQL readback. The Preview deployment tag was matched to the full Git SHA; continuous commit/deployment mapping can be strengthened.
- Rejection of the Production token by Preview (reverse direction); the Production token was not read. Runtime secret strength/distinctness was compared without printing values; the Worker Base Secret was checked by binding name/type and protected-origin routing.
- Production backup existence and restore rehearsal; automated verification that Preview Worker builds map to the expected Git commit.
- Cloudflare WAF/rate-limit configuration and full user-side browser, keyboard-open, and accessibility acceptance.
