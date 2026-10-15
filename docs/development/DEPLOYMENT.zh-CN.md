# 部署与集成

[English](DEPLOYMENT.en.md) · 简体中文

## 当前线上拓扑（只读核验于 2026-10-15）

本项目已有 Production 和独立 Preview。以下为 2026-10-15 核验快照；本轮已获 Owner 明确授权推送 `dev` 并部署 Preview，Production 应用与自定义站点域名保持未修改。

| 环境 | Web / Worker | 源站 | 腾讯云 Compose / Git | 数据库 |
| --- | --- | --- | --- | --- |
| Production | `https://tasklutein.xswt.fyi`；Worker `tasklutein` | `https://origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein`；`main` / `4b4d6e6`；Compose 项目 `deploy`，5 个容器运行 | PostgreSQL 健康；卷 `deploy_tasklutein_db` |
| Preview | `https://dev.preview.tasklutein.xswt.fyi`；Worker Preview 名称 `dev` | `https://preview-origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein-preview`；`dev` / `b9bcd83`；Compose 项目 `tasklutein-preview`，4 个容器运行；Tunnel 使用独立项目 | PostgreSQL 健康；卷 `tasklutein-preview_tasklutein_db` |

两套应用使用独立 Docker 网络、数据库卷和 Tunnel；Host 端口只绑定 `127.0.0.1`。Cloudflare Workers Preview API 列出的 `dev` 最新部署为 #5（`bb47be2b-1151-4bd5-9e87-106e1cb38339`，immutable URL：`https://bb47be2b.preview.tasklutein.xswt.fyi`），部署 tag 是完整提交 SHA `b9bcd8395f2c9c4dcca7143afc92eb412d1daee4`。稳定 Preview URL 与 immutable URL 均提供新 Web bundle；health 为 200、匿名任务 API 为 401。部署含 `ORIGIN_URL=https://preview-origin-tasklutein.xswt.fyi` 与 `ORIGIN_GATEWAY_TOKEN` secret binding（只核对名称/类型，未读取值）。Wrangler 的 Production deployment #5 是独立记录，没有被本轮更新。

经 Owner 明确授权，已将 `xswt.fyi` zone 的 `always_use_https` 从 `off` 改为 `on`；SSL 模式为 `Full`。只读 HEAD 检查覆盖 Cloudflare 返回的 9 条 DNS 记录主机名（含 `dev.preview.tasklutein.xswt.fyi`）：全部 HTTP 请求返回 301 或 308，HTTPS 均可建立连接；Tasklutein Production/Preview `/api/health` 为 200，两个源站 health 仍为 403。唯一 DNS-only 主机返回其自身 308。Worker 的非本地 HTTP→HTTPS 308 兜底也已随 Preview #5 部署。

基础公网检查：Preview `/api/health` 为 200，匿名 `/api/tasks` 和 `/mcp` 为 401；Preview API/MCP 源站直接匿名访问为 403。Production `/api/health` 为 200，Production API 源站直接匿名访问为 403。真实 HTTPS 浏览器创建了唯一 `[smoke-test]` 任务并提交 `source=user` 汇报；远程 MCP `list_tasks` 找到同一任务并成功提交 `source=agent` 汇报。浏览器刷新显示任务和两条不同来源报告；Web API 均返回 200，Preview PostgreSQL SQL 读到同一任务及两条报告。重启 Preview `api` 和 `mcp` 容器后，MCP、SQL 和浏览器刷新仍读回同一数据；数据库容器未重启。随后通过 UI 删除任务，SQL 确认任务/报告行均为 0。Preview #5 已部署汇报 payload 修复；`npm run smoke:preview` 的 health / 匿名拒绝 / 源站拒绝检查通过。Preview Web Token 请求 Production 一个不存在的任务 ID，Production API 返回 401；未读取或写入 Production 任务数据。Production 应用与自定义站点域名未修改；按 Owner 授权启用了 zone 级 HTTPS。未读取 Production Token；备份恢复也未验证。

## 数据流与边界

浏览器与 MCP 客户端统一访问 Cloudflare Worker。Worker 将 API/MCP 请求通过 Cloudflare Tunnel 转给腾讯云 Caddy，再由 FastAPI / Node MCP 访问 PostgreSQL。

- Worker 只提供静态 Web 资产和 `/api/*`、`/mcp` 公网入口；业务校验、任务/汇报持久化由 FastAPI 负责，MCP 工具复用 API。
- Production 与 Preview 使用独立 Worker 运行时配置、Tunnel、Compose 项目和数据库卷。不得把 Preview 数据、端口或密钥接到 Production。
- 网关 Secret 和 Web/Agent Bearer Token 各自独立；密钥只从运行时配置读取，不放入 Git、`wrangler.jsonc` 普通变量、`VITE_*` 或日志。
- HTTP MCP 当前是无状态、每个 POST 一个 transport、JSON 响应；锁文件当前解析的 MCP SDK 最高支持协议版本为 `2025-11-25`。OAuth、事件恢复和 `2026-07-28` 新版传输元数据语义未实现。

## 本地验证与 Preview 只读烟测

Windows 本地仓库检查：

```powershell
npm run check
& .\backend\.venv\Scripts\python.exe -m pytest -q
& .\backend\.venv\Scripts\ruff.exe check backend/app backend/tests
docker compose -f deploy/compose.yml --env-file deploy/.env.preview.example config --quiet
```

`npm run build:worker` 是 Wrangler dry-run，不会部署。`npm run smoke:preview` 是无凭据的只读公网烟测，只检查 Preview health、匿名拒绝与源站拒绝；不会写任务，也不能证明真实鉴权 Token、数据库持久化或 MCP tool call。默认目标是 `dev.preview.tasklutein.xswt.fyi` 和 `preview-origin-tasklutein.xswt.fyi`。

本机 Docker Engine 不可用时，Compose `config --quiet` 只校验静态配置，不等于容器启动或数据库可连接。Preview 真实写入验收需另行约定测试数据和清理方式，并确认只使用 Preview Token。

计划内的认证 API/MCP 闭环可在获准环境中运行 `npm run e2e:preview`。先在当前进程安全地提供 `TASKLUTEIN_PREVIEW_WEB_TOKEN` 和 `TASKLUTEIN_PREVIEW_AGENT_TOKEN`，不要回显或写入文件。脚本固定访问 `dev.preview.tasklutein.xswt.fyi`，要求两个 Token 不同；会创建唯一 `[smoke-test]` 任务、验证 Web CRUD/用户汇报和 MCP Agent 汇报归因，最后删除任务并确认 API 读回 404。失败时会报告清理失败，重跑前先检查唯一标记任务。该脚本验证 API/MCP 闭环，不验证浏览器 DOM、移动设备键盘或服务重启持久性；不要把环境变量设为 Production Token。

## 变更与发布规则

- `dev` 是日常开发和 Preview 分支，`main` 是 Production 发布分支。本轮 Owner 明确授权了提交、推送 `dev`、部署 Preview Worker、运行 Preview E2E 测试和清理；没有修改 Production Worker 或自定义站点域名。未来涉及 Production 发布、服务器配置/密钥修改或 Production 数据写入仍须有相应范围的明确授权。
- 服务器现有目录已经运行，不要重新 clone、重复创建 Tunnel/Worker、重新初始化数据库或重放 `migrations/0001_init.sql`。Preview 目录内有本地 Mihomo Compose override；使用前先在服务器核对实际配置，不要照抄旧命令。
- 任何获批的 Preview 更新都应先记录本地 SHA 和远端 Preview checkout / Worker 版本，检查 Production 目标未变化，然后只更新 Preview Compose 项目。应用回滚不会回滚数据库 schema。
- Production 发布必须有单独批准、备份/恢复证据和明确回滚点。Cloudflare WAF、限流和 Secret 改动属于运行时变更。
- GitHub Release 不等于 Worker 部署；发布和回滚流程见 [`RELEASE.md`](../../RELEASE.md)。

## 尚未验收

- 数据库容器本身重启后的持久性尚未实测；本轮重启 Preview API/MCP 容器后，跨请求和 PostgreSQL 数据仍可读。Preview Worker tag 与完整 Git SHA 已核对；持续自动化的提交/部署映射仍可加强。
- Preview / Production Token 交叉拒绝及密钥独立性；只核对了 Compose/volume/network 拓扑，没有读取 Secret 值。
- 生产备份存在性与恢复演练；Preview Worker 构建自动化与 Git commit 的持续对应关系。
- Cloudflare WAF/限流配置以及用户侧跨浏览器、键盘弹出、完整无障碍验收。
