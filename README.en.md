<div align="center">
  <img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein mark" width="88" height="88">
  <h1>Tasklutein</h1>
  <p><strong>One shared task and progress workspace for people and AI agents</strong></p>
  <p>Manage tasks in a browser and let MCP agents read them and report progress.</p>
  <p>
    <a href="https://tasklutein.xswt.fyi">Open Tasklutein</a> ·
    <a href="README.md">简体中文</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="LICENSE">MIT License</a>
  </p>
</div>

## Features

- **Task management:** create, edit, and delete tasks; filter by todo, in progress, or done.
- **Progress reports:** add multiple reports to a task and distinguish human from agent activity.
- **Shared workspace:** view the same tasks and progress from a phone or desktop browser.
- **MCP agents:** read tasks, update statuses, and submit reports through MCP.

## Get started

1. Open the [Tasklutein workspace](https://tasklutein.xswt.fyi).
2. Enter the Web access token provided by the workspace owner.
3. Create tasks, add descriptions, update statuses, and record progress.

The Web token is stored only in the current browser session. You may need to enter it again when reopening the workspace.

## Connect an MCP agent

Connect your MCP client to `https://tasklutein.xswt.fyi/mcp` and configure the Agent access token provided by the workspace owner. The client must support a custom `Authorization: Bearer` header.

Agents can use these tools:

- `list_tasks`: list tasks, optionally filtered by status.
- `get_task`: read a task and its reports.
- `create_task`: create a task.
- `update_task`: change a task title, description, or status.
- `add_report`: add a progress report to a task.

The server assigns report attribution from the verified token. An agent report records activity; it does not mean the result was independently verified.

## Workspace access

Tasklutein currently has one shared workspace. Web and Agent tokens are issued separately, but both can access every task and report in that workspace. Share tokens only with trusted people and agents.

Individual user accounts, per-user data access, and MCP OAuth sign-in are not available.

## Project

[Changelog](CHANGELOG.md) · [MIT License](LICENSE)
