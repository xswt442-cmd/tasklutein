<div align="center">
  <img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein mark" width="88" height="88">
  <h1>Tasklutein</h1>
  <p><strong>Tasks and progress shared by people and AI agents</strong></p>
  <p>Manage tasks in personal or team workspaces and let MCP agents read them and report progress.</p>
  <p>
    <a href="https://tasklutein.xswt.fyi">Open Tasklutein</a> ·
    <a href="README.md">简体中文</a> ·
    <a href="LICENSE">MIT License</a>
  </p>
</div>

## Features

- **Personal and team workspaces:** visitors can browse the frontend preview; signed-in users have a private workspace and can create teams, invite registered users, and switch workspaces.
- **Task management:** create and edit tasks, then archive them or permanently delete their history; filter, search, sort, and paginate current tasks.
- **Team tasks:** assign work to workspace members, filter by assignee, and use the Inbox to find assigned tasks and reports awaiting review.
- **Overview and history:** see current task totals and recent activity; browse read-only archived task snapshots and reports, and remove individual or grouped activity history.
- **Reports and reviews:** add reports and comments; workspace members can score reports and mark them approved or needing work.
- **MCP agents:** use a workspace-bound Agent key to read and update tasks and assignees, submit reports and comments, and read human reviews.

## Get started

1. Open [Tasklutein](https://tasklutein.xswt.fyi) to browse the interface; sign in through Cloudflare Access to use a personal workspace, or create a team and invite registered users from the Team page.
2. In a team workspace, members can share tasks, assign owners, submit reports, and review reports. Task updates include a version check; inspect the latest task before deciding whether to submit again after a conflict.
3. To connect an Agent, select a workspace in Settings, create an Agent key for it, and save the secret immediately. Plaintext cannot be viewed again; you can edit its name or expiry and permanently delete it. Lists show only `tlu_` plus the next three key characters. Deletion removes the key record; related reports, comments, and activities remain without displaying that key's name.

Tasklutein creates a personal workspace after Cloudflare Access verifies the user. A team owner can invite registered Tasklutein users, who become members after accepting. Workspace access is checked against membership, and switching workspaces does not change personal data. Each Agent key is bound to the workspace selected when it is created; removing its creator from a team immediately invalidates that team key.

## Connect an MCP agent

Remote MCP uses the dedicated MCP host configured for the deployment, at `https://<mcp-host>/mcp`. Set this URL in your MCP client and send the key with `Authorization: Bearer <personal Agent key>`. The MCP host is separate from the Web host; `/mcp` on the Web host does not serve remote MCP. The client must support a custom Authorization header.

Agents can use these tools:

- `list_tasks`: list current-workspace tasks, optionally filtered by status or text and paginated.
- `list_reports`: read a task's reports page by page.
- `get_task`: read a task and its reports.
- `create_task`: create a task.
- `update_task`: change a task title, description, status, or assignee using `expected_version`; on conflict, reread and compare before deciding whether to submit again.
- `add_report`: add a progress report to a task.
- `list_report_comments`: read a page of comments on a report.
- `list_report_reviews`: read human reviews for a report; Agents cannot submit scores.
- `add_report_comment`: add a comment to a report.

An Agent key can access only its bound workspace. The server assigns report attribution from the verified session or key. An Agent report records activity; it does not mean the result was independently verified.

## Migrating existing data

When upgrading an existing database, a maintainer must explicitly assign unowned tasks from the former shared workspace to one signed-in user who has a workspace. The migration preserves those tasks and their existing reports together; it does not split or infer ownership. See the [architecture guide](docs/development/ARCHITECTURE.en.md) for the migration requirements.

## Documentation

- [HTTP API and MCP tools](docs/development/API.en.md)
- [Architecture](docs/development/ARCHITECTURE.en.md)

## License

[MIT](LICENSE)
