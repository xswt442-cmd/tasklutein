<p align="center"><img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein 标志" width="104" height="104"></p>
<h1 align="center">Tasklutein</h1>
<p align="center"><strong>让人和 AI Agent 共用同一份任务与进度</strong></p>
<p align="center">浏览器里安排任务；MCP Agent 读取、更新状态、提交工作汇报。</p>
<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="docs/development/ARCHITECTURE.zh-CN.md">架构</a> ·
  <a href="docs/development/DEPLOYMENT.zh-CN.md">部署</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>
<p align="center">
  <a href="https://github.com/xswt442-cmd/tasklutein/actions/workflows/check.yml"><img alt="Check" src="https://github.com/xswt442-cmd/tasklutein/actions/workflows/check.yml/badge.svg?branch=main"></a>
  <img alt="Development" src="https://img.shields.io/badge/status-development-657483">
  <img alt="Worker + FastAPI" src="https://img.shields.io/badge/stack-Worker%20%2B%20FastAPI-657483">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-657483"></a>
</p>

---

> **v0.1.0 开发骨架 · Production 与独立 Preview 已存在**
> 公开环境的当前状态与实际验收边界见[部署文档](docs/development/DEPLOYMENT.zh-CN.md)。Preview Worker #5 已部署 `dev` 提交 `b9bcd839`。真实 HTTPS 浏览器、Web API、远程 MCP 与 Preview PostgreSQL 闭环通过：Web 创建任务和用户汇报，MCP 查到同一任务并写入 Agent 汇报，浏览器刷新与 SQL 均读回两种来源；API/MCP 容器重启后仍可读回；随后删除并核实测试数据已清理。Preview Token 请求 Production API 被拒绝（401）。数据库容器重启、生产写入和备份恢复仍未验收。身份验证暂为**单工作空间、双 Token**，没有多用户、OAuth 或团队权限。

## 功能

- **任务管理**：新建、查看、编辑标题和说明、删除任务；支持待办、进行中、完成状态与筛选。
- **进度汇报**：每个任务可附加多条汇报；后端根据凭据记录来自用户或 Agent。
- **跨设备 Web**：React 响应式界面，在手机和桌面浏览器打开同一工作空间。
- **通用 MCP**：五个工具（`list_tasks`、`get_task`、`create_task`、`update_task`、`add_report`）；同时提供本地 stdio 与远程 Streamable HTTP 接口。

**限制：** Agent 写下的“Done”或工作汇报不等于已经验收。当前无用户级数据隔离、MCP OAuth、任务调度、审计日志、自动部署或生产级限流。远程 MCP 客户端需要能自行设置 Bearer Header。远程 MCP SDK 最高协议版本为 `2025-11-25`；当前 Preview Worker 部署 tag 与 Git SHA 已核对，自动部署映射仍未实现。

## 架构

```text
Browser / Mobile ─┐
                  ├── Cloudflare Worker (Web Assets + public /api, /mcp)
Remote MCP Agent ─┘                     │ HTTPS / Tunnel
                                       ▼
                       Tencent Docker: Caddy ingress
                         ├── FastAPI ── PostgreSQL
                         └── MCP HTTP ── FastAPI
Local MCP Agent ── stdio adapter ── Worker /api
```

**明确分工：Cloudflare Worker 只负责前端和公网请求入口；腾讯云 Docker 负责业务 API、PostgreSQL 和 MCP Server。** Web 与 MCP 使用同一套 FastAPI 业务逻辑，不需要特定 Agent 客户端或 ligule 才能使用。

## 本地开发

需要 **Node.js 24+、Python 3.12+、PostgreSQL**；完整环境可使用 Docker Compose。克隆仓库后：

```powershell
npm ci
python -m venv backend/.venv
& .\\backend\\.venv\\Scripts\\python.exe -m pip install -r backend/requirements-dev.txt
npm run check
& .\\backend\\.venv\\Scripts\\python.exe -m pytest -q
```

先按 [部署/本地联调指南](docs/development/DEPLOYMENT.zh-CN.md) 准备 PostgreSQL、`backend/.env` 及 Token。快速开发时分别启动 FastAPI 与 Vite：

```powershell
& .\\backend\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --app-dir backend --env-file backend/.env --reload
npm run dev
```

打开 `http://localhost:5173`；浏览器的 `/api/*` 在开发模式由 Vite 代理到 FastAPI。完整 Worker 开发和远程 MCP 参见部署文档。**不要**把生产 Token 放进 `VITE_*` 环境变量或 Git。

## 项目文档

[架构说明](docs/development/ARCHITECTURE.zh-CN.md) · [API / MCP](docs/development/API.zh-CN.md) · [部署指南](docs/development/DEPLOYMENT.zh-CN.md) · [贡献指南](docs/development/CONTRIBUTING.zh-CN.md) · [维护者发布流程](RELEASE.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)
