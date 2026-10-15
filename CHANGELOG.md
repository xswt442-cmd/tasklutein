# Changelog / 更新日志

本项目版本记录参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与语义化版本规范；正式发布之后才把功能归入对应版本。
Changes are recorded in a format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); features are assigned a released version only after an actual release.

## [Unreleased] / 未发布

当前暂无新增变更。 / No pending changes.

## [0.1.0] - 2026-10-15 / 首次发布

### 简体中文

**新增**
- 完成基于 React、Cloudflare Worker（静态资源 + 公网网关）、FastAPI 和 PostgreSQL 的单工作空间任务管理开发骨架。
- 支持创建、查询、编辑、删除任务，以及按任务记录用户/Agent 的进度汇报。
- 新增独立的本地 stdio 与腾讯云 Streamable HTTP MCP 服务，提供五个任务与汇报工具。
- 提供 Docker Compose、Caddy、Cloudflare Tunnel、双令牌与网关密钥的部署配置。
- 增加测试、GitHub Actions Check / Release、双语 README、架构、API、部署、贡献与维护者发布文档。
- Web 任务详情支持编辑标题和说明；“刷新任务”也会重新加载当前任务的汇报时间线。
- Web 新建用户汇报只提交内容，由后端根据认证来源标记；422 校验详情显示为可读路径与消息。
- Web 状态栏现在反映连接中、已连接或暂不可用；401 会清除失效会话，502/503 与网络错误提供重试提示。
- Web 任务标题/说明、工作汇报输入框具备可访问名称，状态筛选组会播报当前选中项。
- Worker 对非本地 HTTP 请求重定向至 HTTPS；Owner 已授权开启 `xswt.fyi` zone 级 Always Use HTTPS，并验证现有 DNS 主机名均跳转至 HTTPS。
- HTTP MCP 限制单个请求体最大 1 MiB，并记录当前 SDK 支持的协议版本范围。
- 为 Cloudflare Wrangler 部署启用 `keep_vars`、增加配置回归测试，防止生产 Dashboard 管理的回源变量被新版本意外清除。
- 新增 PostgreSQL 生产逻辑备份与断网临时容器恢复验收脚本；首次受限权限备份和恢复演练已通过，异机容灾仍待建设。

**已知限制**
- Preview Worker #7 已部署 `dev` 提交 `e314080`。HTTPS 浏览器、Web API、远程 MCP 与 Preview PostgreSQL 完整闭环已通过；API/MCP 容器重启测试和单独的 PostgreSQL 容器重启测试均能读回数据，测试记录已删除并核实。Preview Token 请求 Production API 得到 401。生产 PostgreSQL 已完成受限逻辑备份与断网临时容器恢复演练（仍非异机容灾）；反向 Token 验证尚未完成。Production 应用与自定义站点域名在当轮 Preview 验收时未修改；`xswt.fyi` zone 级 HTTPS 设置按 Owner 授权启用。
- 只有一个共享工作空间；没有多用户登录、RBAC、MCP OAuth、生产限流和自动数据库迁移。

### English

**Added**
- Bootstrapped a single-workspace task platform with React, Cloudflare Worker (Static Assets and public ingress), FastAPI, and PostgreSQL.
- Added task CRUD and human/agent progress reports.
- Added separate local stdio and Tencent-hosted Streamable HTTP MCP transports exposing five task/report tools.
- Added Docker Compose, Caddy, Cloudflare Tunnel, two access tokens, and origin-gateway-secret deployment configuration.
- Added tests, GitHub Actions Check / Release workflows, bilingual READMEs and architecture/API/deployment/contributing guides, plus maintainer release procedures.
- Added title/description editing in the Web task detail and report-timeline reload to the refresh action.
- Web report creation now sends only its content so the backend can derive the report source from authentication; FastAPI validation details are rendered as readable paths and messages.
- The Web connection indicator now reflects loading, connected, and unavailable states; expired-token, 502/503, and network errors receive clear recovery messages.
- Task title/description and report fields have accessible names, and the status-filter group announces its selected option.
- The Worker redirects non-local HTTP requests to HTTPS. With Owner authorization, zone-level Always Use HTTPS is enabled for `xswt.fyi` and the existing DNS hostnames were verified to redirect.
- Limited each HTTP MCP request body to 1 MiB and documented the SDK's supported protocol-version range.
- Enabled Wrangler `keep_vars` with a configuration regression test to prevent accidental deletion of Dashboard-managed production origin variables.
- Added guarded Production PostgreSQL logical-backup and network-isolated, ephemeral-restore verification scripts; the first on-host snapshot and rehearsal passed, while off-host recovery remains pending.

**Known limitations**
- Preview Worker deployment #7 serves commit `e314080` from `dev`. The HTTPS browser, Web API, remote MCP, and Preview PostgreSQL flow passed end to end; separate API/MCP and PostgreSQL restart checks read the test records back before they were deleted and verified absent. A Preview token was rejected by the Production API with 401. The Web app reports connection, expired-token, backend, and network states, and its task/report fields and status filters expose accessible names and selected state. The protected Production PostgreSQL logical backup and network-isolated restore rehearsal have passed (without off-host disaster recovery); reverse token rejection remains unverified. Production app and domain were not changed during the Preview validation; zone-level HTTPS for `xswt.fyi` was enabled with Owner authorization.
- One shared workspace only; no user accounts, RBAC, MCP OAuth, production rate limits, or automated database migrations.
