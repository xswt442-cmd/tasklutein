# Tasklutein · Agent 工程约束

- 本项目由 React/Vite、Cloudflare Worker、腾讯云 Docker/FastAPI/PostgreSQL 和 MCP 组成。先阅读当前代码与相关文档，准确描述现有行为。
- Worker 仅提供静态资源和 `/api/*`、`/mcp` 公网入口；业务校验、任务/汇报持久化由 FastAPI 负责。MCP 使用 REST API，不直接访问 PostgreSQL。
- Web 与 Agent Token 目前拥有同一共享工作区的全部任务权限；没有用户级隔离或 OAuth。由 FastAPI 根据已验证令牌确定汇报来源。Agent 报告不等于独立验证的任务完成。
- 运行时 Gateway Secret、Web/Agent Token 不得进入 Git、日志、`VITE_*`、测试快照和公开文档。
- 正式文档只描述当前功能、真实限制和可重复的命令；不记录本机路径、私有 SSH 别名、部署流水、开发过程、未实现计划或短期验收状态。README 面向使用者，代码注释只说明当前有效的约束。
- `CHANGELOG.md` 为版本说明的唯一文字来源；GitHub Release 从目标 Tag 生成。PR 正文必须中英双语，分别记录最终完成的 Changes/变更和实际通过的 Verification/验证。
- 中英文 README 和开发文档语义一致。发布操作见 [RELEASE](docs/development/RELEASE.md)，架构见 [ARCHITECTURE](docs/development/ARCHITECTURE.en.md)，API 见 [API](docs/development/API.en.md)，贡献与测试见 [CONTRIBUTING](docs/development/CONTRIBUTING.en.md)。
- 根据改动范围运行 `npm run check`、`python -m pytest -q`、`ruff check backend/app backend/tests`；Worker dry-run、SQLite 单测不代表生产验证。
- 保留 `icons/`；`testplace/` 为 Git 忽略的本地实验和 Agent 交接目录。
- Git 提交、推送、切分支、重置、Tag/Release、部署、SSH 修改服务器、变更密钥或生产数据操作均需符合当前任务的明确授权，不得以此前的一次授权推定后续权限。
