# 部署与集成

[English](DEPLOYMENT.en.md) · 简体中文

## 服务部署结构

项目的 Web/Worker 网关与业务服务独立部署。Cloudflare Worker 配置两个 hostname：Web 主机提供 React 静态资源并转发 `/api/*`；MCP 主机只接受 `/mcp`。Worker 将两种入口转发至经 Cloudflare Tunnel 暴露的 Caddy；FastAPI 负责业务与 PostgreSQL 写入，Node MCP 通过 REST API 调用 FastAPI。

Production 和 Preview 使用独立的 Worker 配置、Tunnel、Compose 项目、网络、数据库卷和网关密钥。服务容器的宿主端口限制为 `127.0.0.1` 或 Docker 网络，不把数据库开放到公网。正式站点为 [Tasklutein](https://tasklutein.xswt.fyi)。

为 Web hostname 的 `/api/*` 路径创建 Cloudflare Access 自托管应用，启用 One-time PIN 登录，并使用仅允许受邀邮箱的 Allow 策略；更具体的 `/api/health` 应用可允许公开健康检查。Web 根路径提供公开静态前端，游客仅能浏览不可操作的预览；`GET /api/session/login` 经 Access 验证后把浏览器重定向回首页。为两个 hostname 配置 Worker 路由。Production 的 `WEB_HOST`、`MCP_HOST`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 和 `ORIGIN_URL` 由 Cloudflare 管理；`wrangler.jsonc` 的 `previews.vars` 为分支 Preview 提供隔离值，Preview 网关 Secret `ORIGIN_GATEWAY_TOKEN` 保存在 Previews Base。API 与 MCP 的 `EDGE_GATEWAY_TOKEN` 使用相同值。`WEB_ORIGINS` 设置为 Web 完整 Origin。MCP hostname 不加入浏览器 Access 应用：Worker 仅在该主机的精确 `/mcp` 路径接受个人 Agent 密钥，其余路径全部拒绝。向远程客户端开放前，为 MCP hostname 的 `/mcp` 路径配置 Cloudflare 速率限制规则。

Web Access 应用的 `Session Duration` 设置为 30 天；对应 Allow Policy 使用 `Same as application` 或相同的 30 天时长。全局 Access 会话时长保持不变。30 天应用会话可减少重复 OTP 登录，但会延长有效 Cookie 暴露后的访问时间；退出、到期或清除 Cookie 后需重新认证。

不要将网关密钥或 Agent 密钥写入 Git、前端 `VITE_*` 变量或日志。每个用户在设置中创建自己的 Agent 密钥，MCP 服务不使用共享 Agent 凭据。

## 本地检查与 Preview 烟测

从仓库根目录执行：

```sh
npm ci
uv sync --locked
uv run --locked npm run check
uv run --locked python -m pytest -q
uv run --locked ruff check apps/api/app apps/api/tests
docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
```

`npm run build:worker` 是 Wrangler dry-run；`docker compose config --quiet` 仅验证 Compose 配置。二者不会检查运行中的生产服务。

`npx wrangler preview --name dev` 更新 Web Preview，`npx wrangler preview --name mcp` 更新其专用 MCP Preview；两者使用 `wrangler.jsonc` 中隔离的 `previews.vars`，不要对这些 hostname 运行 Production `wrangler deploy`。`npm run smoke:preview` 检查公开前端和健康检查、未认证 API/MCP 拒绝及源站拒绝；将 `TASKLUTEIN_PREVIEW_MCP_URL` 设置为专用 MCP Preview hostname。取得 Preview 当次授权并通过 One-time PIN 登录后，`npm run e2e:preview` 使用 `TASKLUTEIN_PREVIEW_ACCESS_COOKIE` 和 `TASKLUTEIN_PREVIEW_MCP_URL`；可用 `TASKLUTEIN_PREVIEW_WORKSPACE_ID` 选择已加入的团队工作区，或传入已有的 `TASKLUTEIN_PREVIEW_AGENT_KEY`。未提供 Agent 密钥时，脚本会创建并在测试后删除一个临时工作区密钥。脚本创建唯一标记任务，通过 REST/MCP 验证版本更新、冲突、汇报、评论和评审，然后删除测试任务与临时密钥。Cookie、密钥和工作区 ID 不得写入日志或提交。脚本固定指向 Preview，不得提供 Production 凭据。失败时应先按脚本提示检查测试记录清理情况。

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

已有业务表但没有 `alembic_version` 的数据库不得直接运行 `alembic upgrade head`，以免重复建表。升级应用前，应单独审查和执行对应的数据库迁移；不要重新初始化已有卷或未经审查执行 downgrade。

M1.5 工作区迁移需要先将经过核对的旧数据库升级到 `0002_identity_workspace`：

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env exec -T api alembic upgrade 0002_identity_workspace
```

部署兼容该版本的 API 后，让明确指定的旧数据归属用户通过 Cloudflare Access 登录，由 `/api/session/bootstrap` 创建用户和工作区。若仍有未归属的旧任务，维护者在执行 `0003_task_workspace_required` 时必须显式提供该用户准确的 Access issuer、subject 和已验证邮箱。迁移会把所有未归属任务及原汇报归入该用户的工作区，保留记录 ID 和内容；若身份未匹配到已启用且已有工作区的用户，迁移会停止。确认值必须是 `assign-existing-tasks`。

在 Bash 会话中交互输入归属信息，再运行迁移并清除环境变量：

```sh
read -r -p 'Legacy owner Access issuer: ' TASKLUTEIN_LEGACY_OWNER_ISSUER
read -r -p 'Legacy owner Access subject: ' TASKLUTEIN_LEGACY_OWNER_SUBJECT
read -r -p 'Legacy owner verified email: ' TASKLUTEIN_LEGACY_OWNER_EMAIL
export TASKLUTEIN_LEGACY_OWNER_ISSUER TASKLUTEIN_LEGACY_OWNER_SUBJECT TASKLUTEIN_LEGACY_OWNER_EMAIL
export TASKLUTEIN_LEGACY_TASKS_CONFIRM=assign-existing-tasks
docker compose -f deploy/compose.yml --env-file deploy/.env exec \
  -e TASKLUTEIN_LEGACY_OWNER_ISSUER -e TASKLUTEIN_LEGACY_OWNER_SUBJECT \
  -e TASKLUTEIN_LEGACY_OWNER_EMAIL -e TASKLUTEIN_LEGACY_TASKS_CONFIRM \
  -T api alembic upgrade 0003_task_workspace_required
unset TASKLUTEIN_LEGACY_OWNER_ISSUER TASKLUTEIN_LEGACY_OWNER_SUBJECT \
  TASKLUTEIN_LEGACY_OWNER_EMAIL TASKLUTEIN_LEGACY_TASKS_CONFIRM
```

核对任务与汇报数量及记录 ID 后，再允许第二个受邀用户写入。若不存在未归属任务，执行 `0003_task_workspace_required` 无需提供上述归属信息。系统会阻止迁移回退到不包含工作区隔离的 `0001_baseline`；应用回退也必须保留工作区范围校验。Production 迁移和部署仍需本轮单独授权。

完成 `0003_task_workspace_required` 并核对备份与恢复方案后，将包含目标迁移的 API 镜像构建完成，再依次应用 `0004_task_history` 并更新 API/MCP 服务：

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env build api mcp
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm --no-deps api alembic upgrade 0004_task_history
docker compose -f deploy/compose.yml --env-file deploy/.env up -d api mcp
```

`0004_task_history` 为任务增加可空归档时间并创建活动表；既有任务仍是当前任务，迁移不会补造历史活动。迁移不会自动回退。首次归档后，回退版本必须继续过滤归档任务；不要通过 downgrade 或清除业务历史来恢复旧版本。

升级已部署环境时，备份并确认目标环境后，构建包含当前迁移的 API 镜像，再应用后续迁移并更新 API/MCP：

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env build api mcp
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm --no-deps api alembic upgrade head
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --no-deps api mcp
```

`0005_report_comments` 增加报告评论；`0006_agent_token_hard_delete` 允许物理删除 Agent 密钥，并在保留历史记录的同时清空关联密钥 ID。

## 发布、备份与恢复

- `dev` 对应开发和 Preview，`main` 对应发布源码。跨环境数据、Token、Worker 回源和 Tunnel 配置必须相互隔离。
- `scripts/production-backup.sh` 创建逻辑备份；`scripts/production-restore-check.sh` 在隔离的临时 PostgreSQL 实例中验证恢复。两者在目标服务器的受控 Docker 账户中执行，不能用本地 Docker 假装生产恢复已完成。异机备份、保留期限和周期性演练应由运行环境单独管理。
- Cloudflare Worker 使用 `wrangler.jsonc` 的 `keep_vars` 保留运行时绑定；Production 发布工作流按当前 Cloudflare 配置核验网关密钥类型和公开 HTTP 边界。
- API、MCP、PostgreSQL 的版本、健康、Schema 和备份需分别核对，避免将 GitHub Release 或静态页面 200 误判为整个平台完成部署。

发布授权、回滚及逐层验收步骤见 [发布手册](RELEASE.md)。
