# 更新日志 / Changelog

记录每个版本已交付的功能、修复以及兼容性和升级影响。GitHub Release 从对应标签的本文件自动生成。

This file records shipped features, fixes, compatibility changes, and upgrade requirements. GitHub Release notes are generated from the tagged version section.

## [Unreleased]

### 简体中文

### English

## [0.1.1] - 2026-10-18

### 简体中文

**新增**
- 新增响应式工作台，包括 Overview 统计、任务列表和详情；支持任务搜索、状态筛选、排序、分页以及 URL 保留筛选条件。
- 任务与汇报 API 支持稳定分页、筛选和全工作区统计；MCP 新增 `list_reports` 工具。
- 为 PostgreSQL 引入 Alembic 版本化迁移基线及 PostgreSQL 17 集成测试。

**改进**
- API 与 Worker 支持跨层 Request ID；增加请求日志、受保护的数据库就绪检查与数据库连接超时。
- 为 REST 和 MCP 分别设置请求体大小限制（64 KiB 与 1 MiB），并统一异常响应的安全响应头。

**升级说明**
- 已有 PostgreSQL 数据库需要先核对结构，再由维护者登记 Alembic 基线；应用启动时不会自动运行迁移。
- 当前使用单一共享工作区，Web 和 Agent 令牌都具备全工作区任务访问权限。

### English

**Added**
- Added a responsive console with Overview, task list and detail views, search, status filters, sorting, pagination, and URL-persisted filters.
- Added stable task/report pagination and filtering, workspace-wide totals, and the MCP `list_reports` tool.
- Added an Alembic migration baseline and PostgreSQL 17 integration tests.

**Improved**
- Added cross-layer request IDs, request logging, protected database readiness checks, and database connection timeouts.
- Applied separate REST (64 KiB) and MCP (1 MiB) request body limits and consistent security headers on unexpected errors.

**Upgrade notes**
- Existing PostgreSQL databases require schema verification before an operator records the Alembic baseline; migrations do not run automatically on application startup.
- The product uses one shared workspace; Web and Agent tokens can access every task in that workspace.

## [0.1.0] - 2026-10-15

### 简体中文

首个公开版本。

**新增**
- 提供 React 任务管理界面，支持创建、查询、编辑、删除、状态筛选及用户与 Agent 的进度汇报。
- Cloudflare Worker 提供静态资源与 `/api/*`、`/mcp` 公网入口；FastAPI 与 PostgreSQL 负责业务和持久化。
- MCP 提供本地 stdio 和远程 Streamable HTTP 传输，支持任务读取、创建、更新与报告提交。
- 提供 Docker Compose、Caddy、Cloudflare Tunnel 部署配置以及独立 Web/Agent 令牌和网关密钥。

**改进**
- 改善任务编辑、汇报来源归属、错误提示、表单可访问性和连接状态显示。
- Worker 保护回源密钥绑定并强制安全的 HTTP 处理；增加生产 PostgreSQL 逻辑备份和隔离恢复工具。

**使用限制**
- 单一共享工作区；尚不提供独立用户账户、精细权限或 MCP OAuth。
- 远程 MCP 使用无状态 HTTP 传输；数据库迁移由维护者操作。

### English

Initial public release.

**Added**
- Added a React task interface with CRUD, status filters, and human/Agent progress reports.
- Cloudflare Worker serves static assets and public `/api/*` and `/mcp` ingress; FastAPI and PostgreSQL own business logic and persistence.
- Added local stdio and remote Streamable HTTP MCP transports for task reads, creation, updates, and reporting.
- Added Docker Compose, Caddy, Cloudflare Tunnel, separate Web/Agent tokens, and a gateway secret.

**Improved**
- Improved task editing, server-verified report attribution, error handling, form accessibility, and connection status.
- Hardened Worker origin binding preservation and HTTP handling, with PostgreSQL logical backup and isolated restore tools.

**Limitations**
- One shared workspace, without individual user accounts, fine-grained authorization, or MCP OAuth.
- Remote MCP uses stateless HTTP transport; database migrations require an operator.
