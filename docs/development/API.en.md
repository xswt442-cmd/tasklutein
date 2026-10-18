# HTTP API and MCP Tools

English · [简体中文](API.zh-CN.md)

## Public Ingress and Authentication

Web and remote MCP use separate Cloudflare Worker hostnames. The Web host serves static pages and `/api/*`; the MCP host serves only the exact `/mcp` path, with other paths returning `404`. `/mcp` on the Web host is not forwarded to the MCP server. Use the configured `<web-host>` and `<mcp-host>` values; the two entry points have different URLs.

Web API requests use Cloudflare Access. After verifying the Access JWT, the Worker forwards its issuer, subject, and verified email to FastAPI in internal identity headers, removing any client-supplied headers with those names. Except for `GET /api/health`, the Web API requires an established user identity; the first visit creates the user and personal workspace through `POST /api/session/bootstrap`. The browser does not send a business Bearer token.

Remote MCP clients send a personal Agent key as `Authorization: Bearer <AGENT_KEY>` to `https://<mcp-host>/mcp`. The MCP server uses that key for FastAPI calls; the key's user and personal workspace determine its data scope. Clients must not send `X-Tasklutein-Gateway` or internal identity headers. The Worker injects the gateway header matching `ORIGIN_GATEWAY_TOKEN`; FastAPI and HTTP MCP verify it using `EDGE_GATEWAY_TOKEN`.

`GET /api/health` does not require user identity. `GET /api/ready` requires an established Web identity or a valid Agent key. All business endpoints read or modify only the caller's workspace. A task in another workspace is treated as missing and returns `404`.

## Session and Personal Agent Keys

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/session/bootstrap` | Create or return the user and personal workspace from the identity verified by the Worker |
| GET | `/api/me` | Return the current user and workspace; requires an established Web identity |
| GET | `/api/agent-tokens` | List Agent-key metadata for the current workspace |
| POST | `/api/agent-tokens` | Create a personal Agent key |
| DELETE | `/api/agent-tokens/{uuid}` | Revoke a key in the current workspace |
| GET | `/api/agent/whoami` | Validate an Agent key and return its user, workspace, and key identifiers |

`POST /api/agent-tokens` accepts `{"name":"Build agent","expires_at":null}`. `name` must contain 1–80 characters. Optional `expires_at` must be a future timestamp with a timezone. Success returns `201` with a one-time plaintext `secret` and `token` metadata that does not contain the secret. The server stores only a digest and display prefix; the plaintext cannot be retrieved through the API later. Listed metadata includes `id`, `name`, `prefix`, creation time, expiry, and revocation time. Revocation returns `204`; a key outside the current workspace returns `404`.

Agent keys are for MCP identity validation and the API calls made by MCP. Requests to `/api/*` through the Web hostname use Web identity authentication; that hostname does not provide a public REST login using Agent Bearer keys.

## Task REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check; no user identity required |
| GET | `/api/ready` | Database readiness; requires a valid user or Agent identity |
| GET | `/api/overview` | Task totals and status counts for the current workspace |
| GET | `/api/tasks` | Filter and page tasks in the current workspace |
| POST | `/api/tasks` | Create a task in the current workspace |
| GET | `/api/tasks/{uuid}` | Fetch a task in the current workspace |
| PATCH | `/api/tasks/{uuid}` | Update title, description, or status |
| DELETE | `/api/tasks/{uuid}` | Delete a task and its associated reports |

Create payload:

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

Valid statuses are `todo`, `in_progress`, and `done`. Creation returns `201` with `{"task":...}`; list returns `{"tasks":[],"total":0,"limit":25,"offset":0}`; read and update return `{"task":...}`; deletion returns `204`. Invalid fields return `422`; a task missing from the current workspace returns `404`.

List query parameters are optional `status`, `q` (case-insensitive literal search over title and description, up to 200 characters), `sort` (`updated_desc` or `created_desc`), `limit` (1–200), and nonnegative `offset`. If `limit` is omitted, up to 200 tasks are returned. Results use descending UUID as a secondary sort key. `total` counts every task in the workspace matching the filters, independent of the current page.

`GET /api/overview` returns `total`, `by_status`, and `generated_at`. Status counts cover every task in the current workspace, not just the first 200.

## Report REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | Page reports for a task in the current workspace |
| POST | `/api/tasks/{uuid}/reports` | Append a report and return `201` |

The body accepts only `{"content":"..."}`. FastAPI sets report `source`, user attribution, and Agent-key attribution from the verified identity; clients cannot supply ownership fields. Report creation and task status updates are separate operations. Reports accept `limit` (1–100) and nonnegative `offset`; if `limit` is omitted, up to 100 are returned. Results sort by descending `created_at`, then descending UUID; the response includes `total`, `limit`, and `offset`.

## Remote MCP Streamable HTTP

URL: `https://<mcp-host>/mcp`. On the configured MCP hostname, the Worker routes only the exact `/mcp` path to the Node MCP server in Tencent Docker. Clients must support a custom `Authorization: Bearer <personal Agent key>` header. The lockfile resolves `@modelcontextprotocol/sdk` 1.32.1, whose highest supported protocol version is `2025-11-25` (including the initialization handshake); compatibility with the newer `2026-07-28` transport metadata headers and semantics is not claimed. HTTP mode is stateless, uses an independent MCP transport per POST, and returns JSON; requests are limited to 1 MiB. The server accepts POST only; GET, DELETE, and other methods return `405`. Session replay and OAuth are not implemented; OAuth-only MCP clients may not be compatible.

## MCP Tools

| Tool | Input summary | Behavior |
| --- | --- | --- |
| `list_tasks` | optional status, q, sort, limit, offset | Search and list one page from the key's workspace |
| `list_reports` | task_id (UUID), optional limit and offset | Read one report page for a task in that workspace |
| `get_task` | id (UUID) | Read a task and its default first report page |
| `create_task` | title, optional description | Create a task in the key's workspace |
| `update_task` | id, optional title/description/status | Update a task in that workspace |
| `add_report` | task_id, content | Append an Agent report |

The optional local stdio MCP adapter uses a personal Agent key configured as `TASKLUTEIN_API_TOKEN` and calls the FastAPI REST API for that workspace.

API requests with a declared body larger than 64 KiB return `413`; MCP has a separate 1 MiB request limit. API errors preserve `detail` and include `code` and `request_id`. Validation `detail` is an array of field errors and does not echo rejected input. Each API response includes `X-Request-ID`; the Worker replaces client-supplied IDs before forwarding. Logs contain the request ID, route, method, status, and duration, without request bodies or credentials. Common statuses include missing/invalid identity `401`, unauthorized request or invalid gateway credential `403`, unconfigured gateway or unavailable database `503`, validation `422`, and missing record in the current workspace `404`. The public Worker drops unapproved proxy headers and rejects origin redirects. Fine-grained roles, cursor pagination, API rate limits, OAuth, and a business audit log are not implemented.

## Database Upgrade Compatibility

Migrations do not run automatically when the API starts. For an existing database, first apply `0002_identity_workspace`, have the intended owner sign in through Cloudflare Access and create a personal workspace, then apply `0003_task_workspace_required`. If unassigned tasks from the former shared workspace remain, a maintainer must explicitly provide that user's Access issuer, subject, and email plus the confirmation value `assign-existing-tasks`. The migration preserves those tasks and their associated reports together in that one workspace; it does not infer or split ownership. Existing report source and content are preserved, while user and Agent-key attribution remain unset. See the [architecture guide](ARCHITECTURE.en.md) for the full migration requirements.
