# Tasklutein 发布流程

> **维护者内部手册**，参考 DiggerTerm 的分层方式。这里写检查顺序与权限边界，不是 GitHub Release 说明。给最终用户看的双语 Release Notes 放在 `.github/release-notes/vX.Y.Z.md`，不能直接复制 README 或整个 CHANGELOG。

## 范围与发布定义

Tasklutein 是 **Cloudflare Worker + 腾讯云 Docker + FastAPI + PostgreSQL + MCP** 的双部署项目。GitHub Tag / GitHub Release 只代表代码与发行说明已记录，**不等于** Cloudflare Worker 或腾讯云后端已经上线。生产部署仍由维护者分开执行，没有 GitHub Actions 自动 SSH 或自动写入生产数据库。

`dev` 用于日常功能开发，`main` 用于已验证的可发布代码。Worker 负责 Web Assets 和 `/api/*`、`/mcp` 网关；腾讯云负责持久化、业务以及远程 MCP 服务，禁止把业务逻辑移入 Worker 来规避后端部署。

## 每次发布

1. 在 `dev` 收敛变更、确认测试通过、更新 `CHANGELOG.md` 的中英文 Unreleased。版本号从 `0.1.0` 起，以实际发布状态为准，**尚未实际发布前不能宣称 v0.1.0 已上线**。
2. 同步 `package.json` 与 `package-lock.json` 的版本（可在工作树检查无误后使用 `npm version X.Y.Z --no-git-tag-version`）；如果 MCP 对外协议有变化，同步更新 `packages/mcp/src/server.ts` 的版本、API/架构文档与测试。
3. 从 `.github/release-notes/TEMPLATE.md` 复制为实际的 `.github/release-notes/vX.Y.Z.md`，写**短小、可验证、中英双语**的变化、手动部署提醒及已知限制。保持模板与实际发布记录分离。
4. 在受控环境检查：

   ```powershell
   npm ci
   npm run check
   python -m pytest -q
   ruff check backend/app backend/tests
   docker compose -f deploy/compose.yml --env-file deploy/.env config --quiet
   ```

   其中 `deploy/.env` 仅在维护者环境本地存在。还要验证真实 PostgreSQL 的 Schema、容器镜像、MCP Streamable HTTP、Worker→Tunnel→Caddy 路由。SQLite 单测与 Wrangler dry-run 不能替代生产联调。
5. 在 GitHub 上检查 `dev` 对应的 Check；通过 PR 或非强制快进把验证过的提交合并到 `main`。严禁 force-push、重写已有发布 Tag，或用未经批准的代码直接覆盖线上环境。
6. 从 `main` 已验证提交**显式创建注释 Tag** `vX.Y.Z` 并推送该 Tag。`.github/workflows/release.yml` 会校验 Tag 与 `package.json` 版本、中文/英文 Release Notes、提交属于 `main` 的历史、Node/Python 测试，然后创建 **GitHub Release**。存在同名 Release 时失败而不是覆写。
7. **分别部署**基础设施，操作前由维护者显式授权：
   - Cloudflare Worker：在完成配置的环境按 [DEPLOYMENT.zh-CN.md](docs/development/DEPLOYMENT.zh-CN.md) 通过 Wrangler 或 Git 集成发布。
   - 腾讯云：先备份 PostgreSQL，检查迁移兼容性，再更新 `tx-z02` 上的 Docker 镜像与 Compose 服务；勿在无确认时安装软件、修改安全组或停掉其他容器。
   - 线上核验：Web 登录/任务 CRUD/手机查看、API 401/403、源站直连拒绝、MCP tools/list 与报告写入、数据持久化、服务日志和监控。
8. 核对 GitHub Release、线上版本、变更记录与手动部署结果；若某一层发布失败，应记录状态，不允许把“GitHub Release 已创建”写成“服务已上线”。

## 安全与回滚

- **不提交** `testplace/`、任何 `.env`、`.dev.vars`、Cloudflare Tunnel Token、数据库备份或本地密钥。生产 Token 通过可信密钥管理/运行时环境配置，不能放到前端 `VITE_*` 变量。
- 没有自动数据库迁移：已有 PostgreSQL 数据时新增版本化迁移，并先确认备份与回滚方案；应用 Git 回滚不等于 Schema 回滚。
- Worker 与腾讯云是不同部署单元，需要分别记录上线成功与回滚方式；重放旧代码前确认 API/MCP 协议兼容。
- 不覆盖历史 Release 附件、不重写已有 Tag；修复后发布新版本。
- 尚未支持多用户账户、Agent OAuth 或精细化权限，Release Notes 必须如实披露。
