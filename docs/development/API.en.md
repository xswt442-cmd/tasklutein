# HTTP API and MCP Tools

English · [简体中文](API.zh-CN.md)

## Public Ingress and Authentication

One Cloudflare Worker hostname serves all public access. Static Web Assets live at `/`; `/api/*` proxies to Tencent FastAPI; `/mcp` proxies to Tencent MCP HTTP Server.

The Worker injects `X-Tasklutein-Gateway` using its secret `ORIGIN_GATEWAY_TOKEN`, verified on Tencent using `EDGE_GATEWAY_TOKEN`. Clients must not supply this header. Except `GET /api/health`, business APIs also require `Authorization: Bearer <TOKEN>`. Browser uses `WEB_ACCESS_TOKEN`; agent/API uses `AGENT_ACCESS_TOKEN`. Both currently grant full access to **one shared workspace**, not separate users.

## Task REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health, no user Bearer (still requires origin gateway secret) |
| GET | `/api/tasks` | Up to 200 recently updated tasks; `?status=todo` optional |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks/{uuid}` | Fetch task |
| PATCH | `/api/tasks/{uuid}` | Update title, description, status |
| DELETE | `/api/tasks/{uuid}` | Delete task and associated reports |

Create payload:

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

Valid statuses: `todo`, `in_progress`, `done`. Creation returns `201` with `{"task":...}`; list returns `{"tasks":[...]}`; read/update return `{"task":...}`; deletion returns `204`. Invalid fields return `422`; missing tasks `404`.

## Report REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | Most recent 100 reports |
| POST | `/api/tasks/{uuid}/reports` | Append report, return `201` |

Body accepts only `{"content":"..."}`. FastAPI stamps report `source` as `user` or `agent` based on verified auth, not client-supplied JSON. Report creation and task status updates are separate operations.

## Remote MCP Streamable HTTP

URL: `https://tasklutein.<domain>/mcp`, routed by Worker to the Node MCP Server on Tencent Docker. Clients must support a custom `Authorization: Bearer <AGENT_ACCESS_TOKEN>` header. The lockfile currently resolves `@modelcontextprotocol/sdk` 1.32.1, whose highest supported protocol version is `2025-11-25` (including the initialization handshake); compatibility with the newer `2026-07-28` transport metadata headers and semantics is not claimed. HTTP mode is stateless with a fresh MCP transport per POST and JSON replies; requests are limited to 1 MiB. Session replay and OAuth are not implemented. The server accepts POST only; GET, DELETE, and other methods return `405`. OAuth-only MCP hosts may not be compatible.

## MCP Tools and Errors

| Tool | Input summary | Behavior |
| --- | --- | --- |
| `list_tasks` | optional status | List tasks |
| `get_task` | id (UUID) | Read task and reports |
| `create_task` | title, optional description | Create task |
| `update_task` | id, optional title/description/status | Update task |
| `add_report` | task_id, content | Append agent report |

Optional local stdio MCP provides the same tools, calling Worker `/api/*` over HTTPS or local FastAPI during development.

HTTP statuses: missing/invalid business token `401`; missing/invalid origin secret `403`; unconfigured origin gateway `503`; validation error `422`; missing record `404`. Public Worker drops unapproved proxy headers and rejects origin redirects. RBAC, pagination cursors, API rate limits, OAuth, and audit events are not implemented.
