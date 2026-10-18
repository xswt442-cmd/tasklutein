# 贡献与验证

[English](CONTRIBUTING.en.md) · 简体中文

## Git 工作流

`dev` 是日常开发分支，`main` 作为发布分支。功能变更通过 PR 合入，描述变更原因、用户影响、测试证据、部署及迁移风险。不要把 CI green 写成线上已发布；切分支、commit、push、merge、reset、部署需要明确操作指令。先阅读根目录 `AGENTS.md` 与架构文档。

## TypeScript、Worker 与 MCP

需要 Node.js 24+ 和 Python 3.12+，锁文件为 `package-lock.json`。浏览器工作流测试会启动本机 FastAPI，并使用独立文件版 SQLite；运行完整检查前安装 `backend/requirements-dev.txt`：

```sh
npm ci
python -m pip install -r backend/requirements-dev.txt
npm run check
```

`npm run check` 包含 TypeScript、Vitest（页面通过真实 HTTP 调用 FastAPI，使用隔离 SQLite）、MCP stdio 握手、双语文档、Vite Assets 构建及 `wrangler deploy --dry-run`，**不执行云端部署**。`test/edge.test.ts` 测试 Worker 网关的鉴权与 Header；`test/mcp-http.test.ts` 使用真实 MCP HTTP Client 检查工具和分页。若修改工具契约，务必更新测试和文档。变动依赖要一并更新 package-lock。

## FastAPI 与数据库

需要 Python 3.12+，使用独立虚拟环境并安装 `backend/requirements-dev.txt`，仓库根目录运行：

```sh
python -m pytest -q
ruff check backend/app backend/tests
```

API 行为测试使用隔离 SQLite；PostgreSQL 迁移测试只在显式命名的 `*_test` 专用数据库中创建和清理表。GitHub Actions 使用临时 PostgreSQL 17 服务，并要求迁移集成测试必须运行。需要本地 PostgreSQL 时显式配置：

```powershell
$env:TASKLUTEIN_TEST_DATABASE_URL = 'postgresql+psycopg://tasklutein_test:<本机测试密码>@127.0.0.1:5432/tasklutein_test'
$env:TASKLUTEIN_TEST_DATABASE_NAME = 'tasklutein_test'
$env:TASKLUTEIN_ALLOW_POSTGRES_TEST_RESET = '1'
python -m pytest -q
```

测试夹具会核对 URL 中的本机主机和 `*_test` 数据库名，并要求显式允许重置；随后会删除该数据库中的 `tasks`、`reports` 和 `alembic_version` 表。不得指向 Production 或 Preview。API 测试覆盖任务 CRUD、后端生成的汇报来源、双令牌、网关密钥、筛选、分页和全库统计。PostgreSQL 测试验证 Alembic 升级、接管原有 `0001_init.sql` Schema 后保留既有数据、超出旧列表上限的数据读取，以及在 PostgreSQL 上通过 API 写入。SQLite 成功不能证明 Docker、Tunnel 或在线服务部署正常。

Alembic 基线：全新空 PostgreSQL 执行 `alembic upgrade head`。采用旧版 `migrations/0001_init.sql` 建立的数据库必须先检查并确认符合 `0001_baseline`，再由维护者运行 `alembic stamp 0001_baseline`。不得给未核对的数据库直接 stamp，也不在应用启动时自动执行迁移。

## 文档与安全

中文和英文 README、架构、API、部署和贡献指南成对维护；**CHANGELOG.md 为单文件中英双语**，`docs/development/RELEASE.md` 是维护者发布流程；GitHub Release 从对应 Tag 的 `CHANGELOG.md` 自动生成双语说明。后端、Worker 或 MCP 的用户可见配置需要两种语言同步。禁止提交 `.env`、`.dev.vars`、Token、私有数据库内容、带 Authorization Header 的请求日志或个人机器专属配置。

## 发布与回滚

`.github/workflows/check.yml` 在 `dev` / `main` / PR 验证代码；`.github/workflows/release.yml` 在显式推送符合版本号、位于 `main` 历史中的 Tag 后校验并创建 GitHub Release，**不自动部署基础设施**。Worker 使用 `wrangler.jsonc` 和 `apps/web/dist` 部署到 Cloudflare；FastAPI、PostgreSQL、远程 MCP 部署到腾讯云 Docker。这两层必须分别显式发布并验收，具体流程见 [`RELEASE.md`](RELEASE.md)。当前没有自动 SSH/CD、数据库迁移执行器或 OAuth。部署前确认源站密钥、容器状态、备份和安全组，故障时应用与 Schema 分别回滚。
