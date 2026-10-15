# Changelog / 更新日志

本项目版本记录参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与语义化版本规范；正式发布之后才把功能归入对应版本。
Changes are recorded in a format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); features are assigned a released version only after an actual release.

## [Unreleased] / 未发布

### 简体中文

**新增**
- 完成基于 React、Cloudflare Worker（静态资源 + 公网网关）、FastAPI 和 PostgreSQL 的单工作空间任务管理开发骨架。
- 支持创建、查询、编辑、删除任务，以及按任务记录用户/Agent 的进度汇报。
- 新增独立的本地 stdio 与腾讯云 Streamable HTTP MCP 服务，提供五个任务与汇报工具。
- 提供 Docker Compose、Caddy、Cloudflare Tunnel、双令牌与网关密钥的部署配置。
- 增加测试、GitHub Actions Check / Release、双语 README、架构、API、部署、贡献与维护者发布文档。
- Web 任务详情支持编辑标题和说明；“刷新任务”也会重新加载当前任务的汇报时间线。
- Web 新建用户汇报只提交内容，由后端根据认证来源标记；422 校验详情显示为可读路径与消息。
- Worker 对非本地 HTTP 请求重定向至 HTTPS；Owner 已授权开启 `xswt.fyi` zone 级 Always Use HTTPS，并验证现有 DNS 主机名均跳转至 HTTPS。
- HTTP MCP 限制单个请求体最大 1 MiB，并记录当前 SDK 支持的协议版本范围。

**已知限制**
- Preview Worker #5 已部署 `dev` 提交 `b9bcd839`。HTTPS 浏览器、Web API、远程 MCP 与 Preview PostgreSQL 完整闭环已通过；API/MCP 容器重启后数据仍可读取，测试记录已删除并核实。Preview Token 请求 Production API 得到 401。数据库容器重启和生产备份恢复尚未确认。Production 应用与自定义站点域名未修改；`xswt.fyi` zone 级 HTTPS 设置按 Owner 授权启用。
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
- The Worker redirects non-local HTTP requests to HTTPS. With Owner authorization, zone-level Always Use HTTPS is enabled for `xswt.fyi` and the existing DNS hostnames were verified to redirect.
- Limited each HTTP MCP request body to 1 MiB and documented the SDK's supported protocol-version range.

**Known limitations**
- Preview Worker deployment #5 serves commit `b9bcd839` from `dev`. The HTTPS browser, Web API, remote MCP, and Preview PostgreSQL flow passed end to end; the records remained readable after API/MCP container restarts and were then deleted and verified absent. A Preview token was rejected by the Production API with 401. Database-container restart and Production backup/restore remain unverified. The Production app and custom site domain were not changed; zone-level HTTPS for `xswt.fyi` was enabled with Owner authorization.
- One shared workspace only; no user accounts, RBAC, MCP OAuth, production rate limits, or automated database migrations.
