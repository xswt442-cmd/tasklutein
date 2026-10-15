<p align="center"><img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein mark" width="104" height="104"></p>
<h1 align="center">Tasklutein</h1>
<p align="center"><strong>One shared task and progress workspace for people and AI agents</strong></p>
<p align="center">Plan in a browser; let MCP agents read tasks, update statuses, and submit factual reports.</p>
<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="docs/development/ARCHITECTURE.en.md">Architecture</a> ·
  <a href="docs/development/DEPLOYMENT.en.md">Deployment</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>
<p align="center">
  <a href="https://github.com/xswt442-cmd/tasklutein/actions/workflows/check.yml"><img alt="Check" src="https://github.com/xswt442-cmd/tasklutein/actions/workflows/check.yml/badge.svg?branch=main"></a>
  <img alt="Development" src="https://img.shields.io/badge/status-development-657483">
  <img alt="Worker + FastAPI" src="https://img.shields.io/badge/stack-Worker%20%2B%20FastAPI-657483">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-657483"></a>
</p>

---

> **v0.1.0 development scaffold · Production and an isolated Preview exist**
> See the [deployment guide](docs/development/DEPLOYMENT.en.md) for live status and evidence boundaries. One authenticated Preview API/MCP/PostgreSQL flow has passed with cleanup (task lifecycle, human/agent reports, SQL row verification, and read-after-write). A real browser run created a task and changed its status, but the deployed report request sent a client-controlled `source` and was rejected; the local fix is not deployed and must be retested after an authorized update. Persistence after service restart and Production writes remain unverified. Authentication is currently **one shared workspace with two tokens**, not user accounts, OAuth, or team permissions.

## Features

- **Task management:** create, list, edit task titles and descriptions, delete, and filter tasks across todo, in-progress, and done states.
- **Progress reports:** append reports to tasks; the backend identifies human versus agent attribution from credentials.
- **Responsive Web:** React dashboard for mobile and desktop browsers sharing the same workspace.
- **Standard MCP:** five tools (`list_tasks`, `get_task`, `create_task`, `update_task`, `add_report`), offered through both local stdio and remote Streamable HTTP.

**Limitations:** Agent-authored completion reports are not proof of verification. User-level isolation, MCP OAuth, scheduling, audit trails, automatic infrastructure deployment, and production rate limiting are not implemented. Remote MCP clients need custom Bearer-header support. The remote MCP SDK supports protocol versions through `2025-11-25`; the exact Git SHA for the current Preview Worker is unconfirmed.

## Architecture

```text
Browser / Mobile ─┐
                  ├── Cloudflare Worker (Web Assets + public /api, /mcp)
Remote MCP Agent ─┘                     │ HTTPS / Tunnel
                                       ▼
                       Tencent Docker: Caddy ingress
                         ├── FastAPI ── PostgreSQL
                         └── MCP HTTP ── FastAPI
Local MCP Agent ── stdio adapter ── Worker /api
```

**Explicit ownership: the Cloudflare Worker serves the Web frontend and public ingress only; Tencent Docker owns the business API, PostgreSQL, and MCP Server.** Both the UI and MCP tools use the same FastAPI logic. No specific AI-agent implementation, including ligule, is required.

## Local Development

Requires **Node.js 24+, Python 3.12+, and PostgreSQL**; use Docker Compose for the complete stack. After cloning:

```powershell
npm ci
python -m venv backend/.venv
& .\\backend\\.venv\\Scripts\\python.exe -m pip install -r backend/requirements-dev.txt
npm run check
& .\\backend\\.venv\\Scripts\\python.exe -m pytest -q
```

Prepare PostgreSQL, `backend/.env`, and access tokens using the [local setup/deployment guide](docs/development/DEPLOYMENT.en.md). For rapid development, start FastAPI and Vite separately:

```powershell
& .\\backend\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --app-dir backend --env-file backend/.env --reload
npm run dev
```

Open `http://localhost:5173`. In dev mode Vite proxies browser `/api/*` requests to FastAPI. See deployment docs for full Worker development and remote MCP. **Never** place production secrets in `VITE_*` variables or Git.

## Project Documentation

[Architecture](docs/development/ARCHITECTURE.en.md) · [API / MCP](docs/development/API.en.md) · [Deployment](docs/development/DEPLOYMENT.en.md) · [Contributing](docs/development/CONTRIBUTING.en.md) · [Maintainer release workflow](RELEASE.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)
