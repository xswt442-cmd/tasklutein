# Tasklutein 发布流程

本文是可重复执行的维护者发布手册。GitHub Release 的中英文内容直接从对应 Tag 的 `CHANGELOG.md` 生成。GitHub Release、Cloudflare Worker 部署、腾讯云后端部署和数据库迁移相互独立。

## 发布边界

- `dev` 用于开发和 Preview，`main` 用于正式版本。
- Cloudflare Worker 在 Access 保护的 Web hostname 提供 React 静态资源和 `/api/*`；独立 MCP hostname 只开放 `/mcp`。
- FastAPI、PostgreSQL、MCP、Caddy 和 Tunnel 由腾讯云 Docker 环境承载。
- 创建 Tag 或 GitHub Release 不更新 Worker、服务器、数据库或密钥。生产变更须获得单独授权。

## 发布前检查

1. 核对 `dev` 上的源代码、文档及已完成的 `CHANGELOG.md` Unreleased 条目。
2. 更新 `package.json` 和 `package-lock.json` 的版本，并将对应 Changelog 条目归入 `[X.Y.Z]`；MCP 协议版本如有变化，保持相关代码、契约和测试一致。
3. 运行项目检查：

   ```sh
   npm ci
   uv sync --locked
   uv run --locked npm run check
   uv run --locked python -m pytest -q
   uv run --locked ruff check apps/api/app apps/api/tests
   docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
   ```

4. 检查真实 PostgreSQL Schema、Preview API/MCP/Worker 的兼容性和数据库变更。SQLite 测试、Worker dry-run 和 Compose 静态配置检查不等于生产验收。
5. 对涉及数据库或服务器更新的版本，先确认备份、独立恢复方案、迁移顺序和回滚点。数据库 Schema 不会因应用回退而自动回退。

## Tag 与 GitHub Release

1. 将经过审查、CI 通过的变更合入 `main`。
2. 在 `main` 的发布提交创建并推送新的注释 Tag `vX.Y.Z`。
3. `.github/workflows/release.yml` 验证 Tag 与清单版本一致、属于 `main` 历史、代码检查通过，并从该提交的 CHANGELOG 指定版本自动提取中英文 Release 内容：

   ```sh
   node scripts/release-notes.mjs --changelog CHANGELOG.md --tag vX.Y.Z --manifest package.json
   ```

4. 正文提取失败、Tag/Release 已存在或 CI 不通过时，发布任务失败，不改写旧 Tag 或旧 Release 资产。

## Cloudflare Worker 发布

使用 `.github/workflows/deploy.yml` 的手动 Production 工作流（需配置受限 Cloudflare 凭据及 `production` Environment），或在明确授权的环境中运行 `npm run deploy:worker`。

- 配置独立的 Web 与 MCP hostname 路由到同一 Worker。Web hostname 配置 Cloudflare Access One-time PIN 和邀请邮箱 Allow 策略；MCP hostname 不配置浏览器 Access。
- 为 Worker 设置 `WEB_HOST`、`MCP_HOST`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 和 `ORIGIN_URL`；部署时保留 Dashboard 管理的变量及 Secret `ORIGIN_GATEWAY_TOKEN`。API 和 MCP 服务使用相同的 `EDGE_GATEWAY_TOKEN`。`wrangler.jsonc` 使用 `keep_vars`，部署命令带 `--keep-vars`。
- 在 MCP hostname 的 `/mcp` 路径配置 Cloudflare 速率限制。发布后只读核对 Access 登录、Worker 的主机与路径限制、未认证 Web/MCP 请求拒绝及源站直接访问拒绝。
- 经授权后，先完成 Preview 的双账号隔离验收，再运行 `npm run e2e:preview` 验证 Web CRUD、MCP 和汇报来源。该脚本使用临时 Preview Access Cookie 与个人 Agent 密钥；Worker 回退与服务端版本回退需分别审查，不能回退到不执行工作区隔离的版本。

## 腾讯云 API/MCP 与数据库发布

1. 使用项目维护账户在目标服务器上审查 Docker Compose、数据库卷、实际镜像版本及 Preview/Production 隔离。
2. 数据库 Schema 变更前，先执行经批准的备份与恢复验证；备份脚本是 `scripts/production-backup.sh`，隔离恢复验证为 `scripts/production-restore-check.sh`。脚本应在具备 Docker 授权的目标服务器上执行，不通过本地开发机模拟生产备份。
3. 按 [部署手册](DEPLOYMENT.zh-CN.md) 的 Alembic 规则检查已有数据库并单独执行迁移；不得重新初始化已有数据卷。M1.5 升级先执行 `0002_identity_workspace`，让维护者指定的旧数据归属用户通过 Access 建立工作区，再以该用户的 issuer、subject、email 和确认值执行 `0003_task_workspace_required`。M2 随后应用 `0004_task_history`；既有任务保持当前状态，迁移不补造活动。迁移保留原任务及汇报 ID、内容和来源；不得猜测旧任务的归属。
4. 更新相互兼容的 FastAPI/MCP 容器，检查健康状态、任务/汇报持久化、MCP 工具和认证边界。
5. 出现鉴权、数据、兼容性或服务异常时，停止下一步变更，按审查过的版本和 Schema 策略恢复。

## 安全

- 不提交 `.env`、`.dev.vars`、`testplace/`、Token、备份、私人日志或运行时密钥；绝不把秘密放进前端 `VITE_*` 变量。
- 生产变更、合并、推送、Tag、部署、Schema 更改和密钥轮换需对应范围的明确授权。
- 只有各发布单元真实验收后，才能声称相应服务已经上线。
