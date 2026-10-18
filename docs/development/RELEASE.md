# Tasklutein 发布流程

本文是可重复执行的维护者发布手册。GitHub Release 的中英文内容直接从对应 Tag 的 `CHANGELOG.md` 生成。GitHub Release、Cloudflare Worker 部署、腾讯云后端部署和数据库迁移相互独立。

## 发布边界

- `dev` 用于开发和 Preview，`main` 用于正式版本。
- Cloudflare Worker 提供 React 静态资源及 `/api/*`、`/mcp` 公网网关。
- FastAPI、PostgreSQL、MCP、Caddy 和 Tunnel 由腾讯云 Docker 环境承载。
- 创建 Tag 或 GitHub Release 不更新 Worker、服务器、数据库或密钥。生产变更须获得单独授权。

## 发布前检查

1. 核对 `dev` 上的源代码、文档及已完成的 `CHANGELOG.md` Unreleased 条目。
2. 更新 `package.json` 和 `package-lock.json` 的版本，并将对应 Changelog 条目归入 `[X.Y.Z]`；MCP 协议版本如有变化，保持相关代码、契约和测试一致。
3. 运行项目检查：

   ```sh
   npm ci
   npm run check
   python -m pip install -r apps/api/requirements-dev.txt
   python -m pytest -q
   ruff check apps/api/app apps/api/tests
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

- 部署时保留 Dashboard 管理的 `ORIGIN_URL` 和 Secret `ORIGIN_GATEWAY_TOKEN`；`wrangler.jsonc` 使用 `keep_vars`，部署命令带 `--keep-vars`。
- 发布后只读核对网关绑定的名称、类型、非敏感公开回源 URL，以及 `/api/health` 200、匿名任务 API 401、源站直接匿名访问 403。
- 经过授权后再执行含测试数据的 Web CRUD 与 MCP 校验。Worker 回退与服务端版本回退需分别记录。

## 腾讯云 API/MCP 与数据库发布

1. 使用项目维护账户在目标服务器上审查 Docker Compose、数据库卷、实际镜像版本及 Preview/Production 隔离。
2. 数据库 Schema 变更前，先执行经批准的备份与恢复验证；备份脚本是 `scripts/production-backup.sh`，隔离恢复验证为 `scripts/production-restore-check.sh`。脚本应在具备 Docker 授权的目标服务器上执行，不通过本地开发机模拟生产备份。
3. 按 [部署手册](DEPLOYMENT.zh-CN.md) 的 Alembic 规则检查已有数据库并单独执行迁移；不得重新初始化已有数据卷。
4. 更新相互兼容的 FastAPI/MCP 容器，检查健康状态、任务/汇报持久化、MCP 工具和认证边界。
5. 出现鉴权、数据、兼容性或服务异常时，停止下一步变更，按审查过的版本和 Schema 策略恢复。

## 安全

- 不提交 `.env`、`.dev.vars`、`testplace/`、Token、备份、私人日志或运行时密钥；绝不把秘密放进前端 `VITE_*` 变量。
- 生产变更、合并、推送、Tag、部署、Schema 更改和密钥轮换需对应范围的明确授权。
- 只有各发布单元真实验收后，才能声称相应服务已经上线。
