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

**已知限制**
- 尚未完成公网实际部署与端到端生产验收；当前仅验证了本地构建、HTTP/MCP 协议和部分 API 功能。
- 只有一个共享工作空间；没有多用户登录、RBAC、MCP OAuth、生产限流和自动数据库迁移。

### English

**Added**
- Bootstrapped a single-workspace task platform with React, Cloudflare Worker (Static Assets and public ingress), FastAPI, and PostgreSQL.
- Added task CRUD and human/agent progress reports.
- Added separate local stdio and Tencent-hosted Streamable HTTP MCP transports exposing five task/report tools.
- Added Docker Compose, Caddy, Cloudflare Tunnel, two access tokens, and origin-gateway-secret deployment configuration.
- Added tests, GitHub Actions Check / Release workflows, bilingual READMEs and architecture/API/deployment/contributing guides, plus maintainer release procedures.

**Known limitations**
- No completed public deployment or production end-to-end validation yet; verification covers local builds, protocol handshakes, and selected API flows.
- One shared workspace only; no user accounts, RBAC, MCP OAuth, production rate limits, or automated database migrations.
