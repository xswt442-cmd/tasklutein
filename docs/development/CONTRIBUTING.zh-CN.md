# 贡献与验证

[English](CONTRIBUTING.en.md) · 简体中文

## Git 工作流

`dev` 是日常开发分支，`main` 作为发布分支。功能变更通过 PR 合入，描述变更原因、用户影响、测试证据、部署及迁移风险。不要把 CI green 写成线上已发布；切分支、commit、push、merge、reset、部署需要明确操作指令。先阅读根目录 `AGENTS.md` 与架构文档。

## TypeScript、Worker 与 MCP

需要 Node.js 24+、Python 3.12+ 和 `uv`。JavaScript 与 Python 锁文件分别为 `package-lock.json`、`uv.lock`。浏览器工作流测试会启动本机 FastAPI，并使用独立文件版 SQLite。在仓库根目录执行：

```sh
npm ci
uv sync --locked
uv run --locked npm run check
```

`uv run` 会为浏览器工作流测试提供项目的 Python 环境。当前部署用 Docker 镜像和 CI 仍通过 `apps/api/requirements*.txt` 安装依赖；修改 Python 依赖时需要同步维护其兼容版本约束。

`npm run check` 包含 TypeScript、Vitest（页面通过真实 HTTP 调用 FastAPI，使用隔离 SQLite）、MCP stdio 握手、双语文档、Vite Assets 构建及 `wrangler deploy --dry-run`，**不执行云端部署**。`test/edge.test.ts` 测试 Worker 网关的鉴权与 Header；`test/mcp-http.test.ts` 使用真实 MCP HTTP Client 检查工具和分页。若修改工具契约，务必更新测试和文档。变动依赖要一并更新 package-lock。

## FastAPI 与数据库

根目录 `pyproject.toml` 由 `uv` 管理运行与开发依赖，`.python-version` 指定 Python 3.12。在仓库根目录执行：

```sh
uv sync --locked
uv run --locked python -m pytest -q
uv run --locked ruff check apps/api/app apps/api/tests
```

本地启动 FastAPI 时，从 `apps/api/.env.example` 创建被 Git 忽略的 `apps/api/.env`，配置隔离的 PostgreSQL `DATABASE_URL` 和开发用 `EDGE_GATEWAY_TOKEN`。对**空的本地数据库**执行 `uv run --env-file apps/api/.env alembic -c apps/api/alembic.ini upgrade head`，再运行 `uv run --env-file apps/api/.env uvicorn app.main:app --app-dir apps/api --host 127.0.0.1 --port 8000`。可使用 DBeaver 或 `psql` 查看同一数据库。本地 Vite 代理不提供 Cloudflare Access 身份验证；手动测试真实浏览器登录请使用受 Access 保护的 Preview，隔离的本地 API/MCP 流程由集成测试覆盖。不要创建共享 Web 或 Agent 开发令牌。已有 SQL 初始化表的数据库不得直接当成空库运行迁移。

API 行为测试使用隔离 SQLite；PostgreSQL 迁移测试只在显式命名的 `*_test` 专用数据库中创建和清理表。GitHub Actions 使用临时 PostgreSQL 17 服务，并要求迁移集成测试必须运行。需要本地 PostgreSQL 时显式配置：

```powershell
$env:TASKLUTEIN_TEST_DATABASE_URL = 'postgresql+psycopg://tasklutein_test:<本机测试密码>@127.0.0.1:5432/tasklutein_test'
$env:TASKLUTEIN_TEST_DATABASE_NAME = 'tasklutein_test'
$env:TASKLUTEIN_ALLOW_POSTGRES_TEST_RESET = '1'
python -m pytest -q
```

测试夹具会核对 URL 中的本机主机和 `*_test` 数据库名，并要求显式允许重置；随后会删除该数据库中的 Tasklutein 表。不得指向 Production 或 Preview。API 测试覆盖用户和 Agent 鉴权、工作区隔离、汇报归属、密钥撤销、网关验证、Origin 校验、筛选、分页和统计。PostgreSQL 测试验证并发首次登录只创建一个用户/工作区、Alembic 升级、受控旧任务归属及任务/汇报保留、活动事务回滚、归档快照、历史清理范围和报告写入与归档/删除之间的并发结果。SQLite 成功不能证明 Docker、Tunnel 或在线服务部署正常。

Alembic 基线：全新空 PostgreSQL 执行 `alembic upgrade head`。采用旧版 `apps/api/migrations/0001_init.sql` 建立的数据库必须先检查并确认符合 `0001_baseline`，再由维护者运行 `alembic stamp 0001_baseline`。已有共享工作区先应用 `0002_identity_workspace`，让维护者指定的旧数据归属用户通过 Cloudflare Access 建立工作区，然后设置迁移要求的目标身份与确认值，执行 `0003_task_workspace_required`。不得给未核对的数据库直接 stamp，也不在应用启动时自动执行迁移。

## 文档与安全

中文和英文 README、架构、API、部署和贡献指南成对维护；**CHANGELOG.md 为单文件中英双语**，`docs/development/RELEASE.md` 是维护者发布流程；GitHub Release 从对应 Tag 的 `CHANGELOG.md` 自动生成双语说明。后端、Worker 或 MCP 的用户可见配置需要两种语言同步。禁止提交 `.env`、`.dev.vars`、Token、私有数据库内容、带 Authorization Header 的请求日志或个人机器专属配置。

## 发布与回滚

`.github/workflows/check.yml` 在 `dev` / `main` / PR 验证代码；`.github/workflows/release.yml` 在显式推送符合版本号、位于 `main` 历史中的 Tag 后校验并创建 GitHub Release，**不自动部署基础设施**。Worker 使用 `wrangler.jsonc` 和 `apps/web/dist` 部署到 Cloudflare；FastAPI、PostgreSQL、远程 MCP 部署到腾讯云 Docker。这两层必须分别显式发布并验收，具体流程见 [`RELEASE.md`](RELEASE.md)。当前没有自动 SSH/CD、数据库迁移执行器或 OAuth。部署前确认源站密钥、容器状态、备份和安全组，故障时应用与 Schema 分别回滚。
