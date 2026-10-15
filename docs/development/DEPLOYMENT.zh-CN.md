# 部署与集成

[English](DEPLOYMENT.en.md) · 简体中文

## 当前线上拓扑（只读核验于 2026-10-15）

本项目已有 Production 和独立 Preview。以下为 2026-10-15 核验快照；本轮已获 Owner 明确授权推送 `dev` 并部署 Preview，Production 应用与自定义站点域名保持未修改。

| 环境 | Web / Worker | 源站 | 腾讯云 Compose / Git | 数据库 |
| --- | --- | --- | --- | --- |
| Production | `https://tasklutein.xswt.fyi`；Worker `tasklutein` | `https://origin-tasklutein.xswt.fyi` | `/home/xswt/apps/tasklutein`；`main` / `4b4d6e6`；Compose 项目 `deploy`，5 个容器运行 | PostgreSQL 健康；卷 `deploy_tasklutein_db` |
| Preview | `https://dev.preview.tasklutein.xswt.fyi`；Worker Preview 名称 `dev` | `https://preview-origin-tasklutein.xswt.fyi` | Worker tag `e314080`；VPS API/MCP checkout `dev` / `b9bcd83`；Compose 项目 `tasklutein-preview`，4 个容器运行；Tunnel 使用独立项目 | PostgreSQL 健康；卷 `tasklutein-preview_tasklutein_db` |

两套应用使用独立 Docker 网络、数据库卷和 Tunnel；Host 端口只绑定 `127.0.0.1`。Cloudflare Workers Preview API 列出的 `dev` 最新部署为 #7（`b7924981-26dc-4561-9115-136666908477`，immutable URL：`https://b7924981.preview.tasklutein.xswt.fyi`），部署 tag 是完整提交 SHA `e314080681a8b4b25b111ac7d2332cd948f0eeeb`。稳定 Preview URL 与 immutable URL 提供 Web bundle `/assets/index-DRk5H8X7.js`；health 为 200、匿名任务 API 为 401。部署含 `ORIGIN_URL=https://preview-origin-tasklutein.xswt.fyi` 与 `ORIGIN_GATEWAY_TOKEN` secret binding（只核对名称/类型，未读取值）。Production Worker 仍是独立 deployment #5，本轮未更新。

经 Owner 明确授权，已将 `xswt.fyi` zone 的 `always_use_https` 从 `off` 改为 `on`；SSL 模式为 `Full`。只读 HEAD 检查覆盖 Cloudflare 返回的 9 条 DNS 记录主机名（含 `dev.preview.tasklutein.xswt.fyi`）：全部 HTTP 请求返回 301 或 308，HTTPS 均可建立连接；Tasklutein Production/Preview `/api/health` 为 200，两个源站 health 仍为 403。唯一 DNS-only 主机返回其自身 308。Worker 的非本地 HTTP→HTTPS 308 兜底也已随 Preview #5 部署。

基础公网检查：Preview `/api/health` 为 200，匿名 `/api/tasks` 和 `/mcp` 为 401；Preview API/MCP 源站直接匿名访问为 403。Production `/api/health` 为 200，Production API 源站直接匿名访问为 403。真实 HTTPS 浏览器创建了唯一 `[smoke-test]` 任务并提交 `source=user` 汇报；远程 MCP `list_tasks` 找到同一任务并成功提交 `source=agent` 汇报。浏览器刷新显示任务和两条不同来源报告；Web API 均返回 200，Preview PostgreSQL SQL 读到同一任务及两条报告。重启 Preview `api` 和 `mcp` 容器后，MCP、SQL 和浏览器刷新仍读回原有测试数据；另用单独的任务/汇报确认 PostgreSQL 容器重启后数据仍在。通过 UI 删除后，SQL 确认任务/报告行均为 0。Preview Worker #7 部署可访问名称和筛选选中状态；Playwright 在真实 Preview 的 360/390/430px 视宽检查无横向溢出，按钮最小高度为 44px，状态显示“已连接”。`npm run smoke:preview` 5 项通过。服务器内存配置比较确认 Web、Agent、Gateway、Tunnel 四类运行时 Secret 达到长度/强度要求、同环境内两两不同、跨环境对应项不同；API/MCP 的 Agent/Gateway 配置相符，未输出 Secret 值。Preview Web Token 请求 Production 一个不存在的任务 ID 得到 401，没有读取或写入 Production 任务数据。Cloudflare Zone Rulesets API 只列出 Cloudflare 管理的 Normalization、Managed Free、DDoS L7 三项，无 custom 或 rate-limit ruleset；旧版 rate-limit API 查询不可用，未更改 WAF。已检查 Production 项目目录、`/home/xswt/backups` 和 `/var/backups/tasklutein` 三个常见位置，未发现备份文件；这不证明主机其他位置没有备份。Production Worker、应用、数据和自定义站点域名未修改；zone 级 HTTPS 按 Owner 授权开启。

## 数据流与边界

Playwright 对真实 Preview 页面临时拦截一次 `/api/tasks` 并返回 503（未改服务器），页面显示“连接暂不可用”和重试提示；解除拦截后重载恢复“已连接”。窄屏检查测了 360/390/430px，未发现横向溢出，按钮最小高度为 44px。文本输入可按可访问名称定位，状态筛选组会播报选中态；这不替代真实手机键盘和人工辅助技术验收。

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

- Preview PostgreSQL 容器重启后，唯一测试任务及汇报从 Web、API 和 SQL 读回；测试记录已清理。Preview Worker tag 与完整 Git SHA 已核对；持续自动化的提交/部署映射仍可加强。
- Production Token 对 Preview 的反向交叉拒绝；没有读取 Production Token。API/Agent/Gateway/Tunnel 运行时 Secret 的强度、唯一性和环境差异已只输出布尔值核对；Worker Base Secret 只核对 binding 名称/类型及受保护回源结果。
- 已检查 Production 项目目录及三个常见备份目录但未发现文件；主机其他位置的备份情况和 Production 恢复演练未核实。Preview Worker 构建自动化与 Git commit 的持续对应关系仍可加强。
- 用户侧跨浏览器、实体设备键盘弹出、屏幕阅读器及完整无障碍验收。Cloudflare Zone Rulesets API 当前未列出 custom 或 rate-limit ruleset；没有改动 Cloudflare WAF/限流配置。
