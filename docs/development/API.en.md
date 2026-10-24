# HTTP API and MCP Tools

English · [简体中文](API.zh-CN.md)

## Public Ingress and Authentication

Web and remote MCP use separate Cloudflare Worker hostnames. The Web host serves static pages and `/api/*`; the MCP host serves only the exact `/mcp` path, with other paths returning `404`. `/mcp` on the Web host is not forwarded to the MCP server. Use the configured `<web-host>` and `<mcp-host>` values; the two entry points have different URLs.

Guests can browse the Web frontend, but the guest view does not request workspace data or expose business operations. Cloudflare Access protects the `/api/*` Web API path. After verifying the Access JWT, the Worker forwards its issuer, subject, and verified email to FastAPI in internal identity headers, removing any client-supplied headers with those names. Except for `GET /api/health`, the Web API requires an established user identity; after sign-in, `POST /api/session/bootstrap` creates or reads the user and default personal workspace. `GET /api/session/login` is a Worker-provided Access login entry that redirects to the home page after authentication. The browser does not send a business Bearer token.

The Web Access applications use a 30-day application session, with their Allow Policies inheriting that duration. The global Cloudflare Access session duration is unchanged. A valid retained cookie can be reused when reopening the site; expiry, explicit sign-out, or cookie removal requires authentication again.

Remote MCP clients send an Agent key as `Authorization: Bearer <AGENT_KEY>` to `https://<mcp-host>/mcp`. Each key is bound to the personal or team workspace selected when it was created; the MCP server uses it for FastAPI calls, and the server checks on every request that its creator remains a workspace member. Clients must not send `X-Tasklutein-Gateway` or internal identity headers. The Worker injects the gateway header matching `ORIGIN_GATEWAY_TOKEN`; FastAPI and HTTP MCP verify it using `EDGE_GATEWAY_TOKEN`.

`GET /api/health` does not require user identity. `GET /api/ready` requires an established Web identity or a valid Agent key. All business endpoints read or modify only the caller's current workspace. Browser requests may select a joined workspace with `X-Tasklutein-Workspace-ID`; FastAPI checks membership on every request, so the header cannot grant access by itself. Without it, the personal workspace is selected. Agent keys remain bound to their workspace and cannot switch through this header. A task in another workspace is treated as missing and returns `404`.

## Session and Workspace-bound Agent Keys

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/session/bootstrap` | Create or return the user and personal workspace from the identity verified by the Worker |
| GET | `/api/me` | Return the current user and workspace; requires an established Web identity |
| GET | `/api/agent-tokens` | List Agent-key metadata for the current workspace |
| POST | `/api/agent-tokens` | Create an Agent key for the current workspace |
| PATCH | `/api/agent-tokens/{uuid}` | Update the name or expiry of an active key |
| DELETE | `/api/agent-tokens/{uuid}` | Permanently delete a key in the current workspace |
| GET | `/api/agent/whoami` | Validate an Agent key and return its user, workspace, and key identifiers |

`POST /api/agent-tokens` accepts `{"name":"Build agent","expires_at":null}`. `name` must contain 1–80 characters. Optional `expires_at` must be a future timestamp with a timezone. Success returns `201` with a one-time plaintext `secret` and `token` metadata that does not contain the secret. The server stores only a digest and display prefix; plaintext appears only in the create response and cannot be retrieved through the API later. Metadata `prefix` is limited to `tlu_` plus the first three key characters; list and update responses contain no remaining key characters, plaintext, or digest. The list includes `id`, `name`, `prefix`, creation time, expiry, and revocation time; keys revoked before this migration remain listed until deleted. `PATCH` can update `name` and `expires_at` independently; setting `expires_at` to `null` means no expiry. Only active keys in the current workspace can be updated; revoked keys return `409`, and keys outside the workspace return `404`. `DELETE` physically removes the key row and returns `204`; repeated deletion returns `404`. Associated reports, comments, and activities remain, with `agent_token_id` set to `null`, so historical records no longer show that key's name.

Agent keys are for MCP identity validation and the API calls made by MCP. Requests to `/api/*` through the Web hostname use Web identity authentication; that hostname does not provide a public REST login using Agent Bearer keys.

## Workspaces, Invitations, and Membership

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/workspaces` | List workspaces and the current user's role in each |
| POST | `/api/workspaces` | Create a team workspace; the creator is its Owner |
| GET | `/api/workspaces/{workspace_id}/members` | List team members |
| GET | `/api/workspaces/{workspace_id}/invitations` | List invitations as the team Owner |
| POST | `/api/workspaces/{workspace_id}/invitations` | Invite a registered user as the team Owner |
| GET | `/api/invitations` | List invitations addressed to the current user |
| POST | `/api/invitations/{invitation_id}/accept` | Accept an invitation and join the team |
| POST | `/api/invitations/{invitation_id}/decline` | Decline an invitation |
| DELETE | `/api/workspaces/{workspace_id}/members/{user_id}` | Remove a member as the Owner |

Invitation bodies use `{"email":"member@example.com"}`. The invitee must already have a Tasklutein account; the API does not send email or create accounts. Team roles are `owner` and `member`: Owners can invite or remove members, while team members can use workspace tasks, reports, comments, and reviews. Role changes, Owner departure, and team deletion are not supported. Removing a member revokes their workspace access and invalidates Agent keys they created for that team. Any tasks assigned to them are unassigned in the same transaction; each affected task version increments and an activity is written.

The browser selects its workspace with `X-Tasklutein-Workspace-ID`. FastAPI authorizes the membership on each request, and the header cannot grant access. Omitting it selects the personal workspace. The Worker forwards this selection header and continues to remove forged internal identity headers.

## Task REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check; no user identity required |
| GET | `/api/ready` | Database readiness; requires a valid user or Agent identity |
| GET | `/api/overview` | Current workspace task totals, status counts, and recent activity |
| GET | `/api/tasks` | Filter and page tasks in the current workspace |
| POST | `/api/tasks` | Create a task in the current workspace |
| GET | `/api/tasks/{uuid}` | Fetch a task in the current workspace |
| PATCH | `/api/tasks/{uuid}` | Update title, description, status, or assignee using a task version |
| GET | `/api/inbox` | Page the current user's assigned tasks and reports awaiting review |
| DELETE | `/api/tasks/{uuid}?history=keep` | Archive a task and preserve its snapshot, reports, and activity |
| DELETE | `/api/tasks/{uuid}?history=delete` | Permanently delete a task, reports, and activity |

Create payload:

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

Valid statuses are `todo`, `in_progress`, and `done`. Creation returns `201` with `{"task":...}`; list returns `{"tasks":[],"total":0,"limit":25,"offset":0}`; read and update return `{"task":...}`; deletion returns `204`. Invalid fields return `422`; a task missing from the current workspace returns `404`. The `done` status does not mean that a task is archived.

New tasks start at `version: 1`; list, detail, create, and update responses return the current version. A `PATCH` request must include the version it read in the JSON field `expected_version`, for example `{"title":"Fix release workflow","expected_version":1}`. Omitting it returns `428 expected_version_required`. A stale value returns `409 task_version_conflict` with the current task in the top-level `latest_task` field. The caller should retain its input, reread the task, compare, and then decide whether to submit; the server never silently overwrites or retries. A no-op changes neither version, timestamp, nor activity. Real field changes, version increment, and activity commit in one transaction.

The optional `assignee_user_id` must identify a member of the current workspace; send `null` to clear the assignee. The task-list `assignee` filter accepts `me`, `unassigned`, or a current workspace member UUID. Removing an assignee increments the task version so an editor can detect the change.

`GET /api/inbox` accepts `limit` (1–100, default 20) and nonnegative `offset`, and pages the merged `tasks` and `reports` lists by update time. Tasks are unarchived tasks assigned to the current user. Reports are the latest report by another actor on each current-workspace task, excluding reports this user has reviewed. The inbox is a query view; it does not send notifications.

Current-task endpoints, Overview, search, and MCP task tools include only tasks whose `archived_at` is null. Archived tasks are available only through the History API. Accessing an archived task through a current-task or report endpoint, or accessing a task in another workspace, returns `404`.

List query parameters are optional `status`, `q` (case-insensitive literal search over title and description, up to 200 characters), `sort` (`updated_desc` or `created_desc`), `limit` (1–200), and nonnegative `offset`. If `limit` is omitted, up to 200 tasks are returned. Results use descending UUID as a secondary sort key. `total` counts every task in the workspace matching the filters, independent of the current page.

`GET /api/overview` returns `total`, `by_status`, `recent_activities`, and `generated_at`. Status counts cover every current task in the workspace, not just the first 200; recent activity contains at most five records and is scoped to the same workspace.

## Report REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | Page reports for a task in the current workspace |
| POST | `/api/tasks/{uuid}/reports` | Append a report and return `201` |

Each report can have flat comments; threaded replies are not supported. Comment endpoints are scoped to the report and its task's workspace. Web users and Agent keys in that workspace can read and add comments. The request body is `{"content":"..."}`; after trimming surrounding whitespace, content must contain 1–2,000 characters. Listing accepts `limit` (1–100, default 25) and nonnegative `offset`, sorts stably by creation time and UUID ascending, and returns `comments`, `total`, `limit`, and `offset`. Each comment contains `id`, `report_id`, `content`, `source`, the current `actor_name`, and UTC `created_at`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/reports/{report_id}/comments` | Page comments on a report in the current workspace; archived reports remain readable |
| POST | `/api/reports/{report_id}/comments` | Add a comment and return `201`; archived reports are immutable |
| DELETE | `/api/reports/{report_id}/comments/{comment_id}` | Physically delete a comment; Web users only, and archived reports are immutable |

Comment deletion is permanent. Deleting a report, task, or task history physically cascades to its comments. Creating or deleting a comment creates no activity event and does not change the task's `updated_at`.

The body accepts only `{"content":"..."}`. FastAPI sets report `source`, user attribution, and Agent-key attribution from the verified identity; clients cannot supply ownership fields. The create response's `actor_name` uses the email or Agent key name from the verified identity for that request. Later reads resolve the saved actor ID to the associated record's current email or name. Renaming a key or synchronizing an email can therefore change the displayed name on older reports; the system does not store a name snapshot for the time of the operation. Legacy reports whose actor cannot be recovered return `null`, and the UI displays only their `source`. Reports accept `limit` (1–100) and nonnegative `offset`; if `limit` is omitted, up to 100 are returned. Results sort by descending `created_at`, then descending UUID; the response includes `total`, `limit`, and `offset`. Adding a report does not change the task's `updated_at`.

## Report Review REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/reports/{report_id}/reviews` | Read reviews for a current-workspace report; Web users and Agents can read |
| PUT | `/api/reports/{report_id}/review` | Create or update the current Web user's own review |

Review requests accept an integer `score` (1–5), a `verdict` (`approved` or `needs_work`), and an optional `note` (up to 1,000 characters). Each user has one review per report; repeat submissions update that record. Only human members of the current workspace can write reviews. Agents may read them but cannot submit a score. Archived reports remain readable, but reviews cannot be created or updated after archive. Responses include the reviewer, score, verdict, note, and creation/update times. Reviews do not change the task version or `updated_at`. There is no leaderboard or review-delete API. Reviews cascade with their report when it is deleted.

## History and Activity REST API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/history/tasks` | Filter and page archived tasks in the current workspace |
| GET | `/api/history/tasks/{uuid}` | Read the complete task fields captured at archive time |
| GET | `/api/history/tasks/{uuid}/reports` | Read all reports for an archived task, with pagination |
| DELETE | `/api/history/tasks/{uuid}` | Clear the task's reports and activity; permanently delete it if archived |
| GET | `/api/activity` | Filter and page activity in the current workspace |
| DELETE | `/api/activity/{event_id}` | Delete one activity record in the current workspace |

The task row stores the UTC archive time in `archived_at`; a null value means the task is current. Archiving preserves the original task ID, all task fields, every report, and the associated activity. Archived tasks and reports are read-only. `DELETE /api/tasks/{uuid}?history=keep` archives the task and creates `task.deleted`; `history=delete` physically deletes the task with its reports and activity. Omitting `history` preserves legacy client behavior and physically deletes the full group. When clearing all history for a current task, the task and its state remain while all reports and activity are removed. When the task is archived, the same operation also physically deletes the archived task. IDs outside the current workspace return `404`. History and activity read endpoints are available to Web users and Agents within their workspace; task deletion, whole-history cleanup, and single-activity deletion require a verified Web user identity.

`GET /api/history/tasks` supports `q` (case-insensitive literal search over title and description, up to 200 characters), `limit` (1–200, default 25), and nonnegative `offset`; results sort by descending archive time and then descending UUID. Archived reports accept `limit` (1–100, default 100) and nonnegative `offset`; pagination affects each response, not what is retained. In report and activity responses, `actor_name` is a display label resolved from the associated user's current email or Agent key's current name; it is not a name snapshot, so later renames or email synchronization affect older records' displayed labels. User IDs retain user attribution; an Agent-key ID is retained while the key exists and cleared when it is permanently deleted. The source and user attribution remain, but the deleted key's name is no longer shown. Legacy reports with unknown attribution return `null`. `GET /api/activity` supports filters `source` (`user` or `agent`), `event_type`, and `task_id`, plus `limit` (1–100, default 100) and nonnegative `offset`. Activity records return `actor_type` and `actor_name`. Timestamps are timezone-aware UTC; activity results sort by descending occurrence time and then descending UUID for stable pagination. History and activity queries are scoped to the caller's workspace.

Activity types are `task.created`, `task.updated`, `task.status_changed`, `task.deleted`, and `report.created`. Each real task or report change and its activity record commit in one database transaction; if activity insertion fails, the business change rolls back too. A PATCH that changes status creates one `task.status_changed` event, whose summary may include other fields changed in the same request. A PATCH with no value changes updates neither the task timestamp nor activity. Summaries contain only controlled changed-field and before/after status values; they do not copy task descriptions, report bodies, or secrets. Existing tasks and reports do not receive fabricated events, and past completion times are not inferred from `updated_at`; actor attribution that cannot be recovered for legacy reports remains unknown. Activity is deletable business history, not a tamper-proof security audit log.

Task updates, report creation, archiving, and whole-history cleanup lock the target task and check its archive state. Archived tasks cannot be changed through current-task or report-write endpoints. The transaction keeps task changes and activity records consistent.

## Remote MCP Streamable HTTP

URL: `https://<mcp-host>/mcp`. On the configured MCP hostname, the Worker routes only the exact `/mcp` path to the Node MCP server in Tencent Docker. Clients must support a custom `Authorization: Bearer <personal Agent key>` header. The lockfile resolves `@modelcontextprotocol/sdk` 1.32.1, whose highest supported protocol version is `2025-11-25` (including the initialization handshake); compatibility with the newer `2026-07-28` transport metadata headers and semantics is not claimed. HTTP mode is stateless, uses an independent MCP transport per POST, and returns JSON; requests are limited to 1 MiB. The server accepts POST only; GET, DELETE, and other methods return `405`. Session replay and OAuth are not implemented; OAuth-only MCP clients may not be compatible.

## MCP Tools

| Tool | Input summary | Behavior |
| --- | --- | --- |
| `list_tasks` | optional status, q, sort, limit, offset | Search and list one page from the key's workspace |
| `list_reports` | task_id (UUID), optional limit and offset | Read one report page for a task in that workspace |
| `get_task` | id (UUID) | Read a task and its default first report page |
| `create_task` | title, optional description | Create a task in the key's workspace |
| `update_task` | id, expected_version, optional title/description/status/assignee_user_id | Update task fields or assignee using the version read; reread and compare after a conflict |
| `add_report` | task_id, content | Append an Agent report |
| `list_report_comments` | report_id (UUID), optional limit and offset | Read one page of comments on a report in that workspace |
| `list_report_reviews` | report_id (UUID) | Read human reviews for a report; Agents are read-only |
| `add_report_comment` | report_id (UUID), content | Add an Agent comment to a current report in that workspace |

The optional local stdio MCP adapter uses a personal Agent key configured as `TASKLUTEIN_API_TOKEN` and calls the FastAPI REST API for that workspace. Existing MCP task tools operate only on current tasks and do not read or modify archived tasks.

API requests with a declared body larger than 64 KiB return `413`; MCP has a separate 1 MiB request limit. API errors preserve `detail` and include `code` and `request_id`. Validation `detail` is an array of field errors and does not echo rejected input. Each API response includes `X-Request-ID`; the Worker replaces client-supplied IDs before forwarding. Logs contain the request ID, route, method, status, and duration, without request bodies or credentials. Common statuses include missing/invalid identity `401`, unauthorized request or invalid gateway credential `403`, unconfigured gateway or unavailable database `503`, validation `422`, and missing record in the current workspace `404`. The public Worker drops unapproved proxy headers and rejects origin redirects. Fine-grained roles, cursor pagination, API rate limits, OAuth, and a tamper-proof security audit log are not implemented.

## Database Upgrade Compatibility

Migrations do not run automatically when the API starts. For an existing database, first apply `0002_identity_workspace`, have the intended owner sign in through Cloudflare Access and create a personal workspace, then apply `0003_task_workspace_required`, `0004_task_history`, `0005_report_comments`, `0006_agent_token_hard_delete`, and `0007_team_review_concurrency` in order. If unassigned tasks from the former shared workspace remain, a maintainer must explicitly provide that user's Access issuer, subject, and email plus the confirmation value `assign-existing-tasks`. The migration preserves those tasks and their associated reports together in that one workspace; it does not infer or split ownership. Existing report source and content are preserved, while user and Agent-key attribution remain unset. `0004_task_history` treats existing tasks as current and does not fabricate activity. `0007_team_review_concurrency` marks existing workspaces as personal, backfills owner memberships, and initializes existing task versions to `1` without moving task, report, comment, activity, or Agent-key rows or changing their IDs. `0006_agent_token_hard_delete` permits physical key removal while preserving reports, comments, and activities and clearing their key references. After the first archive, an older backend that ignores `archived_at` would show archived tasks again, so rollback must retain archive filtering and workspace isolation; removing the history schema requires separate review. See the [architecture guide](ARCHITECTURE.en.md) for the full migration requirements.
