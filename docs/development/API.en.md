# HTTP API and MCP Tools

English · [简体中文](API.zh-CN.md)

## Public Ingress and Authentication

One Cloudflare Worker hostname serves all public access. Static Web Assets live at `/`; `/api/*` proxies to Tencent FastAPI; `/mcp` proxies to Tencent MCP HTTP Server.

The Worker injects `X-Tasklutein-Gateway` using its secret `ORIGIN_GATEWAY_TOKEN`, verified on Tencent using `EDGE_GATEWAY_TOKEN`. Clients must not supply this header. Except `GET /api/health`, business APIs also require `Authorization: Bearer <TOKEN>`. Browser uses `WEB_ACCESS_TOKEN`; agent/API uses `AGENT_ACCESS_TOKEN`. Both currently grant full access to **one shared workspace**, not separate users.

## Task REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health, no user Bearer (still requires origin gateway secret) |
| GET | `/api/ready` | Database readiness; requires gateway and business Bearer token |
| GET | `/api/overview` | Workspace-wide task totals by status |
| GET | `/api/tasks` | Filter and page tasks; up to 200 when `limit` is omitted |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks/{uuid}` | Fetch task |
| PATCH | `/api/tasks/{uuid}` | Update title, description, status |
| DELETE | `/api/tasks/{uuid}` | Delete task and associated reports |

Create payload:

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

Valid statuses: `todo`, `in_progress`, `done`. Creation returns `201` with `{"task":...}`; list returns `{"tasks":[],"total":0,"limit":25,"offset":0}`; read/update return `{"task":...}`; deletion returns `204`. Invalid fields return `422`; missing tasks `404`.

List query parameters are optional `status`, `q` (case-insensitive literal search over title and description, up to 200 characters), `sort` (`updated_desc` or `created_desc`), `limit` (1–200), and nonnegative `offset`. Omitting `limit` preserves the original response of up to 200 tasks; new clients should set the page size explicitly. Results use descending UUID as a secondary sort key. `total` counts every task that matches the filters, independent of the current page.

`GET /api/overview` returns `total`, `by_status`, and `generated_at`. Status counts cover every task in the shared workspace, not just the first 200. The timestamp describes when this summary was calculated.

## Report REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | Page reports; up to 100 when `limit` is omitted |
| POST | `/api/tasks/{uuid}/reports` | Append report, return `201` |

Body accepts only `{"content":"..."}`. FastAPI stamps report `source` as `user` or `agent` based on verified auth, not client-supplied JSON. Report creation and task status updates are separate operations. Reports accept `limit` (1–100) and nonnegative `offset`; omitting `limit` preserves the original response of up to 100 reports. Results sort by descending `created_at`, then descending UUID; the response includes `total`, `limit`, and `offset`.

## Remote MCP Streamable HTTP

URL: `https://tasklutein.<domain>/mcp`, routed by Worker to the Node MCP Server on Tencent Docker. Clients must support a custom `Authorization: Bearer <AGENT_ACCESS_TOKEN>` header. The lockfile currently resolves `@modelcontextprotocol/sdk` 1.32.1, whose highest supported protocol version is `2025-11-25` (including the initialization handshake); compatibility with the newer `2026-07-28` transport metadata headers and semantics is not claimed. HTTP mode is stateless with a fresh MCP transport per POST and JSON replies; requests are limited to 1 MiB. Session replay and OAuth are not implemented. The server accepts POST only; GET, DELETE, and other methods return `405`. OAuth-only MCP hosts may not be compatible.

## MCP Tools and Errors

| Tool | Input summary | Behavior |
| --- | --- | --- |
| `list_tasks` | optional status, q, sort, limit, offset | Search and list one task page |
| `list_reports` | task_id (UUID), optional limit and offset | Read one report page |
| `get_task` | id (UUID) | Read a task and its first report page |
| `create_task` | title, optional description | Create task |
| `update_task` | id, optional title/description/status | Update task |
| `add_report` | task_id, content | Append agent report |

Optional local stdio MCP provides the same tools, calling Worker `/api/*` over HTTPS or local FastAPI during development.

API requests with a declared body larger than 64 KiB are rejected with `413`; MCP keeps its separate 1 MiB request limit. API errors preserve `detail` and add a stable `code` and `request_id`. Validation `detail` remains an array of field errors, but rejected input values are omitted. Each API response includes `X-Request-ID`; the Worker replaces client-supplied IDs before forwarding. Logs contain the request ID, route, method, status, and duration, without request bodies or credentials. HTTP statuses include missing/invalid business token `401`, missing/invalid origin secret `403`, unconfigured gateway or unavailable database `503`, validation `422`, and missing record `404`. Public Worker drops unapproved proxy headers and rejects origin redirects. RBAC, cursor pagination, API rate limits, OAuth, and a business audit log are not implemented.
