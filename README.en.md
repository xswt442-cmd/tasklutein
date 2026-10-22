<div align="center">
  <img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein mark" width="88" height="88">
  <h1>Tasklutein</h1>
  <p><strong>Tasks and progress shared by people and AI agents</strong></p>
  <p>Manage tasks in a personal workspace and let MCP agents read them and report progress.</p>
  <p>
    <a href="https://tasklutein.xswt.fyi">Open Tasklutein</a> ·
    <a href="README.md">简体中文</a> ·
    <a href="LICENSE">MIT License</a>
  </p>
</div>

## Features

- **Personal workspaces:** visitors can browse the frontend preview; after Cloudflare Access sign-in, each user has a separate workspace.
- **Task management:** create and edit tasks, then archive them or permanently delete their history; filter, search, sort, and paginate current tasks.
- **Overview and history:** see current task totals and recent activity; browse read-only archived task snapshots and reports, and remove individual or grouped activity history.
- **Reports and comments:** add multiple reports to a task and flat comments to each report, with user and Agent attribution.
- **MCP agents:** use a personal Agent key to read and update tasks and submit reports in its owner's workspace.

## Get started

1. Open [Tasklutein](https://tasklutein.xswt.fyi) to browse the interface; sign in through Cloudflare Access to use a workspace.
2. Create tasks, update their statuses, and record progress. When removing a task, archive it to keep its history or permanently delete the full history.
3. To connect an Agent, open Settings, create a personal Agent key, and save the secret immediately. Its plaintext cannot be viewed again; you can edit its name or expiry and revoke it. Lists show only `tlu_` plus the next three key characters, and retain revoked keys with their status.

Tasklutein creates a workspace after Cloudflare Access verifies the user. Workspaces are isolated by Access issuer and user subject; current tasks, archived history, activity records, overview data, and Agent keys are scoped to their workspace.

## Connect an MCP agent

Remote MCP uses the dedicated MCP host configured for the deployment, at `https://<mcp-host>/mcp`. Set this URL in your MCP client and send the key with `Authorization: Bearer <personal Agent key>`. The MCP host is separate from the Web host; `/mcp` on the Web host does not serve remote MCP. The client must support a custom Authorization header.

Agents can use these tools:

- `list_tasks`: list current-workspace tasks, optionally filtered by status or text and paginated.
- `list_reports`: read a task's reports page by page.
- `get_task`: read a task and its reports.
- `create_task`: create a task.
- `update_task`: change a task title, description, or status.
- `add_report`: add a progress report to a task.
- `list_report_comments`: read a page of comments on a report.
- `add_report_comment`: add a comment to a report.

An Agent key can access only its owner's personal workspace. The server assigns report attribution from the verified session or key. An Agent report records activity; it does not mean the result was independently verified.

## Migrating existing data

When upgrading an existing database, a maintainer must explicitly assign unowned tasks from the former shared workspace to one signed-in user who has a workspace. The migration preserves those tasks and their existing reports together; it does not split or infer ownership. See the [architecture guide](docs/development/ARCHITECTURE.en.md) for the migration requirements.

## Documentation

- [HTTP API and MCP tools](docs/development/API.en.md)
- [Architecture](docs/development/ARCHITECTURE.en.md)

## License

[MIT](LICENSE)
