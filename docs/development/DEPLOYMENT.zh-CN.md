# 部署与集成

[English](DEPLOYMENT.en.md) · 简体中文

## 服务部署结构

项目的 Web/Worker 网关与业务服务独立部署。Cloudflare Worker 提供 React 静态资源，将 `/api/*` 和 `/mcp` 转发至经 Cloudflare Tunnel 暴露的 Caddy；FastAPI 负责业务与 PostgreSQL 写入，Node MCP 通过 REST API 调用 FastAPI。

Production 和 Preview 使用独立的 Worker 配置、Tunnel、Compose 项目、网络、数据库卷及 Token。服务容器的宿主端口限制为 `127.0.0.1` 或 Docker 网络，不把数据库开放到公网。正式站点为 [Tasklutein](https://tasklutein.xswt.fyi)。

环境密钥在 Cloudflare Dashboard / 服务器运行时配置；`ORIGIN_URL` 是 Worker 的可信回源地址，`ORIGIN_GATEWAY_TOKEN` 是 Worker Secret，后端验证对应的 `EDGE_GATEWAY_TOKEN`。Web 与 Agent 使用不同的业务 Bearer Token。不要把值放进仓库、前端 `VITE_*` 变量或日志。

## 本地检查与 Preview 烟测

从仓库根目录执行：

```sh
npm ci
npm run check
python -m pip install -r apps/api/requirements-dev.txt
python -m pytest -q
ruff check apps/api/app apps/api/tests
docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
```

`npm run build:worker` 是 Wrangler dry-run；`docker compose config --quiet` 仅验证 Compose 配置。二者不会检查运行中的生产服务。

`npm run smoke:preview` 发起无凭据的只读请求，检查 Preview 健康、匿名 API 拒绝和回源拒绝。通过授权后，`npm run e2e:preview` 使用当前进程提供的 `TASKLUTEIN_PREVIEW_WEB_TOKEN` 和 `TASKLUTEIN_PREVIEW_AGENT_TOKEN` 测试 REST/MCP：创建唯一标记任务、记录 user/agent 汇报、读取并删除测试记录。脚本固定指向 Preview，不要使用 Production 凭据。失败时应根据脚本提示检查测试记录清理情况。

## PostgreSQL 基线与迁移

Docker Compose 的新建数据库卷使用 `apps/api/migrations/0001_init.sql` 初始化，该 Schema 对应 Alembic `0001_baseline`。应用启动不自动执行迁移。

- **已有业务表的数据库**：先确认环境、数据卷、完整备份与恢复途径；检查表、列、约束、外键、默认值和索引与基线一致。经批准后执行：

  ```sh
  docker compose -f deploy/compose.yml exec -T api alembic stamp 0001_baseline
  ```

- **没有业务表的空数据库**（未执行 Compose 初始化脚本）：经确认后执行：

  ```sh
  docker compose -f deploy/compose.yml exec -T api alembic upgrade head
  ```

已有业务表但没有 `alembic_version` 的数据库不得直接运行 `alembic upgrade head`，以免重复建表。升级应用前，应单独审查和执行对应的数据库迁移；不要重新初始化已有卷或未经审查执行 downgrade。生产数据库操作需要单独授权。

## 发布、备份与恢复

- `dev` 对应开发和 Preview，`main` 对应发布源码。跨环境数据、Token、Worker 回源和 Tunnel 配置必须相互隔离。
- `scripts/production-backup.sh` 创建逻辑备份；`scripts/production-restore-check.sh` 在隔离的临时 PostgreSQL 实例中验证恢复。两者在目标服务器的受控 Docker 账户中执行，不能用本地 Docker 假装生产恢复已完成。异机备份、保留期限和周期性演练应由运行环境单独管理。
- Cloudflare Worker 使用 `wrangler.jsonc` 的 `keep_vars` 保留运行时绑定；Production 发布工作流按当前 Cloudflare 配置核验网关密钥类型和公开 HTTP 边界。
- API、MCP、PostgreSQL 的版本、健康、Schema 和备份需分别核对，避免将 GitHub Release 或静态页面 200 误判为整个平台完成部署。

发布授权、回滚及逐层验收步骤见 [发布手册](RELEASE.md)。
