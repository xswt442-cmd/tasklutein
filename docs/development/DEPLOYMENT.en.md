# Deployment and Integration

English · [简体中文](DEPLOYMENT.zh-CN.md)

## Current Live Topology (Read-Only Audit, 2026-10-15)

Production and an isolated Preview already exist. This is a snapshot from 2026-10-15. For this run, the Owner explicitly authorized pushing `dev` and deploying Preview; the Production app and custom site domain were not changed.

| Environment | Web / Worker | Origin | Tencent Compose / Git | Database |
| --- | --- | --- | --- | --- |
| Production | `https://tasklutein.xswt.fyi`; Worker `tasklutein` | `https://origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein`; `main` / `4b4d6e6`; Compose project `deploy`, 5 running containers | PostgreSQL healthy; volume `deploy_tasklutein_db` |
| Preview | `https://dev.preview.tasklutein.xswt.fyi`; Worker Preview name `dev` | `https://preview-origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein-preview`; `dev` / `b9bcd83`; Compose project `tasklutein-preview`, 4 running containers; separate Tunnel project | PostgreSQL healthy; volume `tasklutein-preview_tasklutein_db` |

The environments use separate Docker networks, database volumes, and Tunnels; host ports bind to `127.0.0.1` only. The Cloudflare Workers Preview API lists deployment #5 as latest for Preview `dev` (`bb47be2b-1151-4bd5-9e87-106e1cb38339`; immutable URL: `https://bb47be2b.preview.tasklutein.xswt.fyi`). Its deployment tag is the full commit SHA `b9bcd8395f2c9c4dcca7143afc92eb412d1daee4`. The stable and immutable Preview URLs serve the new Web bundle; health is 200 and anonymous task API is 401. Deployment configuration has `ORIGIN_URL=https://preview-origin-tasklutein.xswt.fyi` and an `ORIGIN_GATEWAY_TOKEN` secret binding (name/type only; value not read). Wrangler's Production deployment #5 is a separate record and was not updated.

With explicit Owner authorization, the `xswt.fyi` zone's `always_use_https` setting was changed from `off` to `on`; SSL mode is `Full`. Read-only HEAD checks covered all nine hostnames in the Cloudflare DNS result (including `dev.preview.tasklutein.xswt.fyi`): HTTP requests returned 301 or 308, and HTTPS connections succeeded. Production and Preview Tasklutein `/api/health` return 200; both direct origin health requests remain 403. The only DNS-only hostname returns its own 308. The Worker HTTP-to-HTTPS fallback is also deployed in Preview #5.

Baseline public checks: Preview `/api/health` returned 200; anonymous `/api/tasks` and `/mcp` returned 401; direct anonymous Preview API/MCP origin requests returned 403. Production `/api/health` returned 200 and its API origin returned 403 anonymously. A real HTTPS browser created a tagged task and a `source=user` report; remote MCP `list_tasks` found that same task and added a `source=agent` report. Browser refresh displayed the task and both reports; Web API reads returned 200, and Preview PostgreSQL contained that task and both reports. The task was then deleted through the UI, and SQL confirmed zero remaining task/report rows. Preview #5 includes the Web report-payload fix; `npm run smoke:preview` passed health, anonymous rejection, and origin rejection checks. Persistence after API/DB process restart remains unverified. No Production tasks/database were written, and the Production app and custom site domain were not changed; zone-level HTTPS changed with Owner authorization. Production and Preview token values were not compared; backup recovery was not verified.

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

- `dev` is for daily development and Preview; `main` is the Production release branch. For this run, the Owner explicitly authorized the commit, `dev` push, Preview Worker deployment, Preview E2E writes, and cleanup. No Production Worker or custom site domain was changed. Future Production releases, server configuration/key changes, or Production data writes need authorization scoped to those actions.
- Existing server directories are already running. Do not clone them again, recreate Tunnels/Workers, reinitialize databases, or replay `migrations/0001_init.sql`. The Preview checkout has a local Mihomo Compose override; inspect the actual server configuration before using it, and do not copy older commands blindly.
- Any approved Preview update should record the local SHA and remote Preview checkout/Worker version first, verify that the Production target is unchanged, then update only the Preview Compose project. Rolling back application code does not roll back database schema.
- Production release requires separate approval, backup/restore evidence, and an explicit rollback point. Cloudflare WAF, rate limits, and Secret changes are runtime changes.
- A GitHub Release is not a Worker deployment. See [`RELEASE.md`](../../RELEASE.md) for release and rollback procedures.

## Not Yet Verified

- Persistence after API/DB container restarts remains untested; cross-request writes and PostgreSQL readback passed. The Preview deployment tag was matched to the full Git SHA; continuous commit/deployment mapping can be strengthened.
- Preview/Production token cross-rejection and secret independence. Only Compose/volume/network topology was checked; Secret values were not read.
- Production backup existence and restore rehearsal; automated verification that Preview Worker builds map to the expected Git commit.
- Cloudflare WAF/rate-limit configuration and full user-side browser, keyboard-open, and accessibility acceptance.
