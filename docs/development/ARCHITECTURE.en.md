# Architecture

English · [简体中文](ARCHITECTURE.zh-CN.md)

## Components and Ownership

Cloudflare **only serves the web frontend and public ingress**. The Worker serves built React files with Assets and proxies `/api/*` and `/mcp` to a fixed HTTPS Tencent origin. It never connects to PostgreSQL, runs task business rules, or hosts the MCP server.

Tencent Cloud `tx-z02` runs Docker Compose services: `api` (FastAPI/SQLAlchemy), `db` (PostgreSQL), `mcp` (Node.js/MCP SDK Streamable HTTP), `router` (Caddy), and optionally `tunnel` (cloudflared).

```text
Browser -> https://app.example.com/ -- Cloudflare Worker Assets -> React
Browser -> https://app.example.com/api/* -- Worker --> Tunnel --> Caddy --> FastAPI --> PostgreSQL
Agent   -> https://app.example.com/mcp   -- Worker --> Tunnel --> Caddy --> MCP HTTP --> FastAPI
Local Agent -> local MCP stdio adapter --> Worker /api/* or local FastAPI
```

## Network and Authentication Boundaries

Web, REST, and remote MCP share one public Worker hostname. The Worker proxies only allowed paths and serves everything else through Assets. `ORIGIN_URL` comes from the trusted Worker runtime, not client input. The gateway overwrites forged `X-Tasklutein-Gateway` headers with its `ORIGIN_GATEWAY_TOKEN` secret. Browser cookies and non-allowlisted headers are dropped. Origin 3xx redirects are rejected to avoid forwarding credentials elsewhere.

On Tencent, FastAPI and HTTP MCP first verify `EDGE_GATEWAY_TOKEN` (matching the Worker secret), then separately enforce browser/agent Bearer Tokens. FastAPI derives report authorship from authentication rather than trusting client JSON. Both browser and agent credentials currently allow full read/write access to one shared workspace, without user isolation or OAuth.

A Cloudflare Tunnel origin hostname may be reachable directly, but without the gateway secret, FastAPI/MCP refuse access. PostgreSQL, FastAPI, and Caddy host ports bind to `127.0.0.1` only; MCP HTTP publishes no host port. Production needs independent strong random secrets, Cloudflare rate limiting, and security monitoring.

## Database and API as Source of Truth

PostgreSQL is the production source of truth. `migrations/0001_init.sql` initializes the existing Compose volume setup; `backend/alembic/` contains the versioned migration baseline. Existing databases must be inspected before an operator stamps that baseline. Tasks store title, description, status, and timestamps; reports reference tasks through a cascading foreign key. FastAPI owns validation, pagination, full-workspace summaries, and all writes. MCP calls REST, preserving one business-rule boundary for browsers and agents.

## MCP Transports and Limits

`packages/mcp/src/server.ts` registers six tools, including paginated task/report readers. `index.ts` uses stdio. `http.ts` implements the Streamable HTTP server on Tencent. The HTTP transport is stateless, with an independent transport per request: suitable for scaling but no cross-request session state, server-initiated notifications, or event replay. It uses a static Bearer Token; OAuth, dynamic client registration, and public MCP Registry publication are not implemented.

The Worker forwards requests and streaming responses. MCP GET/SSE features depend on server transport support. The current stateless server primarily uses POST/JSON, and must not be advertised as a durable resumable SSE session server. Remote MCP clients must support custom Authorization headers.

## Code Boundaries and Extensibility

- `apps/edge/`: Worker entrypoint, HTTP gateway, static Asset binding.
- `apps/web/`: React, Vite/Tailwind, same-origin `/api` client.
- `backend/app/`: business API, token auth, ORM, response models.
- `packages/mcp/`: stdio + HTTP adapters calling REST, no business SQL.
- `migrations/`: PostgreSQL DDL; `deploy/`: Caddy/Docker/Tunnel.
- `backend/alembic/`: versioned PostgreSQL migrations; `migrations/0001_init.sql` remains the initial volume bootstrap schema.
- `test/` and `backend/tests/`: gateway, MCP, API, and auth checks.

MCP, FastAPI, and PostgreSQL can be scaled or separated independently while keeping the Worker routing contract stable. Before production growth, add scoped user authorization, backup policy, credential rotation, end-to-end deployment tests, and external rate limiting.
