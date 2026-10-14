# Deployment and Integration

English · [简体中文](DEPLOYMENT.zh-CN.md)

## Target Topology and Prerequisites

**Cloudflare Worker** serves React, `/api/*`, and `/mcp` through one public gateway. **Tencent Cloud `tx-z02`** runs FastAPI, PostgreSQL, and remote MCP Server in Docker. Internal Caddy dispatches API/MCP paths, while Cloudflare Tunnel carries HTTPS origin requests to Caddy. Business data stays on Tencent.

These are **repository deployment configurations, not evidence of a live deployment**. No cloud resources, production services, or real secrets have been provisioned. Node.js 24+ is required to build the Worker; Ubuntu needs Docker Engine and Docker Compose v2. Earlier read-only inspection found Ubuntu 24.04 and Docker Engine on `tx-z02` but no Compose v2 plugin. Recheck before installing.

Plan two distinct hostnames; never route the origin hostname back to the app Worker:
- **Public app:** `https://tasklutein.<domain>` (Worker: web, `/api/*`, `/mcp`).
- **Tunnel origin:** `https://origin-tasklutein.<domain>` (Worker-only origin guarded by a shared secret).

## Step 1: Initialize Tencent Docker

This guide does **not** automatically SSH or install anything. After `ssh tx-z02`, if `docker compose version` is unavailable, an authorized server administrator can install:

```sh
sudo apt-get update
sudo apt-get install -y docker-compose-v2
docker compose version
```

After merging verified code to `main` and pushing it, deploy from the release branch:

```sh
mkdir -p ~/apps
git clone --branch main https://github.com/xswt442-cmd/tasklutein.git ~/apps/tasklutein
cd ~/apps/tasklutein/deploy
cp .env.example .env
chmod 600 .env
```

Edit `deploy/.env`, using `openssl rand -hex 32` to generate **four different** secrets: `POSTGRES_PASSWORD`, `WEB_ACCESS_TOKEN`, `AGENT_ACCESS_TOKEN`, and `EDGE_GATEWAY_TOKEN`. Never use placeholder values. `CF_TUNNEL_TOKEN` can remain empty until the next step.

```sh
cd ~/apps/tasklutein/deploy
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build db api mcp router
docker compose --env-file .env ps
```

`api` binds to host `127.0.0.1:8000`, `router` to `127.0.0.1:8080`, and PostgreSQL only to `127.0.0.1:55432`. Remote MCP publishes no host port. **Do not** open ports 8000/8080/55432/3000 in the Tencent security group. The Docker volume persists PostgreSQL. `migrations/0001_init.sql` runs once for a fresh database volume. Add versioned migrations and back up data for later schema changes.

In production the API requires an origin gateway secret, so a direct `curl http://127.0.0.1:8000/api/health` returning 403 is expected. For loopback diagnostics, supply `X-Tasklutein-Gateway` using securely sourced credentials, not plaintext command history or logs.

## Step 2: Initialize Cloudflare Tunnel

In Cloudflare Dashboard → Zero Trust → Networks → Tunnels → Create Tunnel, choose Docker/cloudflared. Store the given Tunnel Token only in Tencent's `deploy/.env` as `CF_TUNNEL_TOKEN`, never in Git or browser builds.

Add a public hostname `origin-tasklutein.<domain>` with HTTP service URL **`http://router:8080`** (same Docker Compose network). Confirm the DNS/Tunnel route.

```sh
cd ~/apps/tasklutein/deploy
docker compose --env-file .env --profile tunnel up -d
docker compose --env-file .env --profile tunnel ps
```

The origin hostname can be addressed from the internet, but **cannot bypass origin gateway checks**: direct requests to `/api/health` must receive 403, and MCP also requires a valid Agent Bearer Token. Cloudflare Tunnel itself is not app authentication. Cloudflare Access Service Tokens could provide another layer later, but must also be configured in Worker requests; they are not implemented by this scaffold.

## Step 3: Initialize Cloudflare Worker

Root `wrangler.jsonc` defines the Worker name `tasklutein`, entrypoint `apps/edge/src/index.ts`, static assets in `apps/web/dist`, Worker-first routing for `/api/*` and `/mcp`, and an SPA fallback. **Do not create a Pages project**; this is a Worker + Assets deployment.

Choose one initialization flow:

1. **Recommended Git integration:** Cloudflare Dashboard → Workers & Pages → Create Worker → Connect to Git, select `xswt442-cmd/tasklutein`, repository root, build command `npm ci && npm run build:web`, deploy command `npx wrangler deploy`, and production branch `main`.
2. **Manual initialization:** Run `npx wrangler login` from the repository root (interactive browser authorization), then `npm ci`, `npm run build:web`, and `npx wrangler deploy`. Wrangler will create/update the named Worker. Do not independently create a duplicate Git deployment.

Set Worker runtime variables/secrets in Cloudflare dashboard:

| Key | Storage | Example |
| --- | --- | --- |
| `ORIGIN_URL` | Worker runtime variable | `https://origin-tasklutein.<domain>` |
| `ORIGIN_GATEWAY_TOKEN` | Worker **Secret** | Exactly equals Tencent `EDGE_GATEWAY_TOKEN` |

You may use `npx wrangler secret put ORIGIN_GATEWAY_TOKEN` interactively. Never put credentials in `wrangler.jsonc` public `vars` or Vite `VITE_*` build variables. With Git deployment, confirm runtime secrets persist across deployments.

Map the Worker to `tasklutein.<domain>`, or test with `*.workers.dev` first. Browser requests `/api/*` on **the same public origin**. No `VITE_API_BASE_URL` or browser-to-Tencent CORS configuration is needed.

## Step 4: Local Worker and MCP Development

On Windows, run `npm ci` and `npm run check`. `npm run build:web` creates the assets; `npm run build:worker` performs a local Wrangler dry run, creating no cloud resources.

With a local Docker Compose installation, copy `deploy/.env.example` to private `deploy/.env`, set secrets, and start `db api mcp router`. Then copy root `.dev.vars.example` to `.dev.vars`:
- `ORIGIN_URL=http://127.0.0.1:8080` (HTTP allowed only on local loopback).
- `ORIGIN_GATEWAY_TOKEN` exactly equals the local `deploy/.env` `EDGE_GATEWAY_TOKEN`.

```powershell
npm run dev:worker
```

Check `http://127.0.0.1:8787/api/health`, then authenticated task operations. The faster Vite `npm run dev` workflow proxies to local FastAPI with `EDGE_GATEWAY_TOKEN` unset in that development server; it does not replace full Worker/Tunnel validation.

## Step 5: Public Acceptance and MCP Client

Verify `https://tasklutein.<domain>/api/health` succeeds while direct `https://origin-tasklutein.<domain>/api/health` returns 403. `/api/tasks` without Bearer must return 401; with valid `WEB_ACCESS_TOKEN` task CRUD works and data persists after mobile refresh.

Remote MCP URL: **`https://tasklutein.<domain>/mcp`**, using HTTP Streamable MCP. Requests must contain `Authorization: Bearer <AGENT_ACCESS_TOKEN>`. The MCP implementation runs in the Tencent Node container; Cloudflare only routes packets. MCP clients supporting custom authentication headers can use the URL; OAuth-only clients cannot connect directly yet.

Local stdio MCP remains available through `npm run mcp` with `TASKLUTEIN_API_BASE` set to the public Worker site (without `/api`) and `TASKLUTEIN_API_TOKEN` set to the Agent Token. Do not place real credentials in agent prompts or committed MCP configuration.

## Run the `main` Production site and `dev` Preview together

Use one Cloudflare Worker, `tasklutein`: `main` is Production and non-production branches use `npx wrangler preview`. The custom domain `preview.tasklutein.xswt.fyi` is configured for **Preview only** (the root hostname is disabled and Preview subdomains are enabled), so the stable Preview URL for branch `dev` is `https://dev.preview.tasklutein.xswt.fyi`. Do not treat the root `preview.tasklutein.xswt.fyi` as the dev site.

The repository's [wrangler.jsonc](../../wrangler.jsonc) points Preview `ORIGIN_URL` to the separate Preview origin. Production continues to use its Production Runtime Settings. The Preview API, database, and Tunnel must also be deployed separately; do not share the Production backend.

Keep the Production checkout at `~/apps/tasklutein`; create a separate `dev` checkout and Compose project:

```sh
git clone --branch dev https://github.com/xswt442-cmd/tasklutein.git ~/apps/tasklutein-preview
cd ~/apps/tasklutein-preview/deploy
cp .env.preview.example .env.preview
chmod 600 .env.preview
```

Edit `.env.preview` and generate fresh, unique values for `POSTGRES_PASSWORD`, `WEB_ACCESS_TOKEN`, `AGENT_ACCESS_TOKEN`, and `EDGE_GATEWAY_TOKEN`. Do not reuse Production secrets. Keep the separate ports `55433`, `8001`, and `8081`. Set `CF_TUNNEL_TOKEN` only after creating the dedicated Preview origin Tunnel.

In Cloudflare Zero Trust, create a **second, separate Tunnel** with public hostname `preview.origin-tasklutein.xswt.fyi` and service `http://router:8080`. Put its Tunnel Token in Preview `.env.preview` as `CF_TUNNEL_TOKEN`, then start only the Preview stack:

```sh
cd ~/apps/tasklutein-preview/deploy
docker compose --project-name tasklutein-preview --env-file .env.preview config --quiet
docker compose --project-name tasklutein-preview --env-file .env.preview up -d --build db api mcp router
docker compose --project-name tasklutein-preview --env-file .env.preview --profile tunnel up -d tunnel
docker compose --project-name tasklutein-preview --env-file .env.preview ps
```

The Compose project name creates a separate network and a database volume prefixed with `tasklutein-preview_`. Preview PostgreSQL binds only to `127.0.0.1:55433`; it is not exposed publicly. To update Preview, run `git pull --ff-only` in `~/apps/tasklutein-preview`, then run `docker compose --project-name tasklutein-preview --env-file .env.preview up -d --build` from its `deploy` directory. Never run these commands from the Production checkout.

In Cloudflare Dashboard → Workers & Pages → `tasklutein` → Settings → Variables and Secrets → **Previews Base**, add the `ORIGIN_GATEWAY_TOKEN` Secret. Its value must exactly match the Preview `.env.preview` `EDGE_GATEWAY_TOKEN`. Production and Preview tokens must be different. Preview `ORIGIN_URL` is provided by `previews.vars` in `wrangler.jsonc`.

The `ORIGIN_PREVIEW_URL` from the earlier screenshot is not read by the Worker and should be removed from Preview Base. Do not put gateway tokens in the repository, build variables, or plaintext variables.

Confirm Cloudflare Workers Builds uses `main` as the Production branch, Preview Builds are enabled, and the Preview command is `npx wrangler preview`. After pushing `dev`, verify Production `https://tasklutein.xswt.fyi/api/health` and Preview `https://dev.preview.tasklutein.xswt.fyi/api/health` are healthy. A task created in Preview must appear only in Preview. Direct requests to origin `/api/health` should return 403.

## Updates, Rollbacks, and Security Checklist

Use `dev` for ongoing development and Preview, and `main` for Production. GitHub Actions `check.yml` runs CI; `release.yml` creates a GitHub Release after an explicitly pushed valid Tag, but **never deploys Worker or SSH-deploys Tencent**. See the maintainer [`RELEASE.md`](../../RELEASE.md) for release order and rollback procedures. Before release, check PR, `npm run check`, backend pytest/Ruff, and real PostgreSQL/MCP integration. Production and Preview use separate checkouts and Compose projects; Cloudflare Git Builds deploy the appropriate Worker version for each branch.

Back up PostgreSQL before migrations; reverting app code never reverses database schema. Production also needs Cloudflare rate limits/WAF, redacted logs, secret rotation, and alerts. No multi-user accounts, MCP OAuth, automated secret rotation, or production migration orchestration exists yet.
