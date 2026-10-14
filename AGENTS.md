# Tasklutein · Agent notes

- Tasklutein is an early-stage **React + Cloudflare Worker / FastAPI + PostgreSQL / MCP** project. Make small, verifiable changes; never claim a cloud deployment or multi-user feature before it exists.
- **Cloudflare Worker only serves static Web assets and public HTTP ingress** (`/api/*`, `/mcp`). Business rules, task/report persistence, and remote MCP execution belong to Tencent Docker. Do not connect Worker directly to PostgreSQL.
- FastAPI is the source of truth for task CRUD, report attribution, validation, and database writes. MCP (stdio and HTTP) must call the REST API, not bypass the backend.
- The single-workspace Web and Agent tokens are separate but both allow full task access; there is no RBAC/OAuth. Production origin gateway secrets must stay in runtime configuration and be checked independently. Never put secrets in frontend `VITE_*` variables or logs.
- Agent reports are factual activity claims, **not verified proof of completion**. Avoid auto-marking tasks done without verification.
- Run `npm run check`, `python -m pytest -q`, and Ruff before proposing releases. Worker dry-run and SQLite tests do not validate production PostgreSQL/Tunnel/Docker.
- Keep `README.md` and `README.en.md` aligned. Keep `CHANGELOG.md` bilingual in **one file**. The internal `RELEASE.md` is not GitHub Release copy; user-visible per-version notes belong in `.github/release-notes/`.
- `dev` is for development and `main` for releases. Never switch branches, commit, push, merge, reset, deploy, SSH-mutate servers, rotate keys, or edit existing user assets without explicit instructions.
- Preserve `icons/` and ignore `testplace/` (local scratch and agent handoffs, not versioned). Avoid checking in dependencies, caches, build artifacts or personal files.
- Read [architecture](docs/development/ARCHITECTURE.en.md), [API](docs/development/API.en.md), and [contributing](docs/development/CONTRIBUTING.en.md) when working on the corresponding part.
