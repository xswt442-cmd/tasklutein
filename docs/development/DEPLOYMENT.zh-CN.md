# 部署与集成

[English](DEPLOYMENT.en.md) · 简体中文

## 当前线上拓扑（只读核验于 2026-10-15）

本项目已有 Production 和独立 Preview。以下是检查时的快照，不代表当前代码已部署，也不授权对云端或服务器进行修改。

| 环境 | Web / Worker | 源站 | 腾讯云 Compose / Git | 数据库 |
| --- | --- | --- | --- | --- |
| Production | `https://tasklutein.xswt.fyi`；Worker `tasklutein` | `https://origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein`；`main` / `4b4d6e6`；Compose 项目 `deploy`，5 个容器运行 | PostgreSQL 健康；卷 `deploy_tasklutein_db` |
| Preview | `https://dev.preview.tasklutein.xswt.fyi`；Worker Preview 名称 `dev` | `https://preview-origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein-preview`；`dev` / `a0e7910`；Compose 项目 `tasklutein-preview`，4 个容器运行；Tunnel 使用独立项目 | PostgreSQL 健康；卷 `tasklutein-preview_tasklutein_db` |

两套应用使用独立 Docker 网络、数据库卷和 Tunnel；Host 端口只绑定 `127.0.0.1`。Cloudflare Workers Preview API 当前列出 `dev` Preview 的最新部署为 #3（`691758a8-4d02-489b-9cf5-bab3237895e4`，immutable URL：`https://691758a8.preview.tasklutein.xswt.fyi`）。只读部署详情显示该版本 `ORIGIN_URL` 为 `https://preview-origin-tasklutein.xswt.fyi`，且有 `ORIGIN_GATEWAY_TOKEN` secret binding（只核对名称/类型，未读取值）。稳定 Preview URL 与 immutable URL 当前返回相同 JS 资源哈希；immutable URL 的 health 为 200、匿名任务 API 为 401。部署元数据没有 Git SHA，仍不能证明它对应哪个提交。Wrangler 的生产 deployment #5 是独立记录，不能用来替代 Preview 版本证据。

经 Owner 明确授权，已将 `xswt.fyi` zone 的 `always_use_https` 从 `off` 改为 `on`；SSL 模式为 `Full`。只读 HEAD 检查覆盖 Cloudflare 返回的 9 条 DNS 记录主机名（含 `dev.preview.tasklutein.xswt.fyi`）：全部 HTTP 请求返回 301 或 308，HTTPS 均可建立连接；Tasklutein Production/Preview `/api/health` 为 200，两个源站 health 仍为 403。唯一 DNS-only 主机返回其自身 308。Worker 本地非 localhost HTTP→HTTPS 308 兜底仍尚未部署。Cloudflare 文档说明 Always Use HTTPS 在边缘重定向所有 HTTP 请求。

基础公网检查：Preview `/api/health` 为 200，匿名 `/api/tasks` 和 `/mcp` 为 401；Preview API/MCP 源站直接匿名访问为 403。Production `/api/health` 为 200，Production API 源站直接匿名访问为 403。后续已通过公开 Preview Worker 做一次带 `[smoke-test]` 标记的认证 API/MCP/PostgreSQL 闭环：Web Token 创建任务、改为 `in_progress`、写用户汇报并跨请求读回；远程 MCP 完成 initialize、tools/list、`list_tasks` 和 `add_report`；Web Token 读回 `source=user` / `source=agent` 两条汇报。SQL 仅按该测试 ID 直接核对 PostgreSQL 任务及两条汇报行已提交；删除任务后，SQL 确认任务/汇报行均清零，API 任务和汇报端点返回 404。另一次真实浏览器测试成功创建任务并改状态，但当前已部署 Web 在汇报请求中发送了客户端 `source`，API 按设计以 422 拒绝；测试任务已删除，计数回到 0。本地 Web 已修正为只发送 `content` 并为 422 错误增加可读格式，尚未部署。浏览器 Mock API 的桌面/390px 页面布局和 Agent 来源显示也已通过。API/DB 进程重启持久性仍未验收；Production 任务/数据库未写入，但 Owner 授权下修改了 zone 级 HTTPS 重定向。Production 与 Preview 的实际 Token 值未比较，备份恢复也未验证。

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

- `dev` 是日常开发和 Preview 分支，`main` 是 Production 发布分支。当前用户授权只覆盖本地修改/验证及已执行的只读盘点；提交、推送、部署、SSH 修改、密钥轮换和 Production 写入仍需单独明确授权。
- 服务器现有目录已经运行，不要重新 clone、重复创建 Tunnel/Worker、重新初始化数据库或重放 `migrations/0001_init.sql`。Preview 目录内有本地 Mihomo Compose override；使用前先在服务器核对实际配置，不要照抄旧命令。
- 任何获批的 Preview 更新都应先记录本地 SHA 和远端 Preview checkout / Worker 版本，检查 Production 目标未变化，然后只更新 Preview Compose 项目。应用回滚不会回滚数据库 schema。
- Production 发布必须有单独批准、备份/恢复证据和明确回滚点。Cloudflare WAF、限流和 Secret 改动属于运行时变更。
- GitHub Release 不等于 Worker 部署；发布和回滚流程见 [`RELEASE.md`](../../RELEASE.md)。

## 尚未验收

- Preview Web 汇报功能的本地修复尚未部署；部署后需复验真实 Web 汇报、刷新读回和 PostgreSQL 持久化。远程 MCP initialize/tools/list 与真实 tool call 已通过。
- Preview / Production Token 交叉拒绝及密钥独立性；只核对了 Compose/volume/network 拓扑，没有读取 Secret 值。
- 生产备份存在性与恢复演练；Worker 精确部署 SHA；Preview Worker 构建自动化与 Git commit 的对应关系。
- Cloudflare WAF/限流配置以及用户侧跨浏览器、键盘弹出、完整无障碍验收。
