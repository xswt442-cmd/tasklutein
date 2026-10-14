# 贡献与验证

[English](CONTRIBUTING.en.md) · 简体中文

## Git 工作流

`dev` 是日常开发分支，`main` 作为发布分支。功能变更通过 PR 合入，描述变更原因、用户影响、测试证据、部署及迁移风险。不要把 CI green 写成线上已发布；切分支、commit、push、merge、reset、部署需要明确操作指令。先阅读根目录 `AGENTS.md` 与架构文档。

## TypeScript、Worker 与 MCP

需要 Node.js 24+。锁文件为 `package-lock.json`：

```sh
npm ci
npm run check
```

`npm run check` 包含 TypeScript、Vitest、MCP stdio 握手、双语文档、Vite Assets 构建及 `wrangler deploy --dry-run`，**不执行云端部署**。`test/edge.test.ts` 测试 Worker 网关的鉴权与 Header；`test/mcp-http.test.ts` 使用真正的 MCP HTTP Client 进行握手。若修改工具契约，务必更新测试和文档。变动依赖要一并更新 package-lock。

## FastAPI 与数据库

需要 Python 3.12+，使用独立虚拟环境并安装 `backend/requirements-dev.txt`，仓库根目录运行：

```sh
python -m pytest -q
ruff check backend/app backend/tests
```

API 测试隔离使用 SQLite，生产环境采用 PostgreSQL；测试涵盖任务 CRUD、汇报来源、双令牌和源站密钥门禁。SQLite 成功不能替代真实 PostgreSQL 迁移、Docker、Tunnel、MCP 流式路径及部署验收。生产数据库已存在时，新增版本化迁移，禁止直接修改最初的 DDL 期待自动执行。

## 文档与安全

中文和英文 README、架构、API、部署和贡献指南成对维护；**CHANGELOG.md 为单文件中英双语**，`RELEASE.md` 是维护者流程，`.github/release-notes/vX.Y.Z.md` 才是发布给用户的双语说明。后端、Worker 或 MCP 的用户可见配置需要两种语言同步。禁止提交 `.env`、`.dev.vars`、Token、私有数据库内容、带 Authorization Header 的请求日志或个人机器专属配置。

## 发布与回滚

`.github/workflows/check.yml` 在 `dev` / `main` / PR 验证代码；`.github/workflows/release.yml` 在显式推送符合版本号、位于 `main` 历史中的 Tag 后校验并创建 GitHub Release，**不自动部署基础设施**。Worker 使用 `wrangler.jsonc` 和 `apps/web/dist` 部署到 Cloudflare；FastAPI、PostgreSQL、远程 MCP 部署到腾讯云 Docker。这两层必须分别显式发布并验收，具体流程见 [`RELEASE.md`](../../RELEASE.md)。当前没有自动 SSH/CD、数据库迁移执行器或 OAuth。部署前确认源站密钥、容器状态、备份和安全组，故障时应用与 Schema 分别回滚。
