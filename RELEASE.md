# Tasklutein 发布流程

> **维护者内部手册**，参考 DiggerTerm 的分层方式。这里写检查顺序与权限边界，不是 GitHub Release 说明。给最终用户看的双语 Release Notes 放在 `.github/release-notes/vX.Y.Z.md`，不能直接复制 README 或整个 CHANGELOG。

## 范围与发布定义

Tasklutein 是 **Cloudflare Worker + 腾讯云 Docker + FastAPI + PostgreSQL + MCP** 的双部署项目。GitHub Tag / GitHub Release 只代表代码与发行说明已记录，**不等于** Cloudflare Worker 或腾讯云后端已经上线。生产部署仍由维护者分开执行，没有 GitHub Actions 自动 SSH 或自动写入生产数据库。

`dev` 用于日常功能开发，`main` 用于已验证的可发布代码。Worker 负责 Web Assets 和 `/api/*`、`/mcp` 网关；腾讯云负责持久化、业务以及远程 MCP 服务，禁止把业务逻辑移入 Worker 来规避后端部署。

## Production 发布前的阻断性检查

> **2026-10-15 核验状态：** `main` 落后于 `dev`；生产腾讯云 checkout 为 `main/4b4d6e6`。已在腾讯云生产 DB 卷**之外**生成受限权限的 `pg_dump -Fc` 备份，SHA-256 校验通过，并在 `--network none`、`tmpfs` 临时 PostgreSQL 17 中恢复出 `tasks`/`reports` 表、核对记录数（当时生产为 0/0）。生产和 Preview 的 API/MCP 容器镜像 SHA 一致，Git 对比表明本轮没有后端业务 API 契约变化。**这是一份同主机备份，不是异地容灾；合并 `main` 前仍须确认快照仍可读取、保存回滚点并由维护者明确授权。**

1. **备份与恢复：** 生产备份存放在维护者私有目录（默认 `~/backups/tasklutein-production/`），权限为目录 700、文件 600，**不在**数据库 Volume 内。使用 `scripts/production-backup.sh` 重新制作时间戳备份与 SHA-256；再用 `scripts/production-restore-check.sh` 在断网、RAM 后端的临时 PostgreSQL 中恢复。操作从不覆盖/重启现有生产 DB，恢复容器自动清理。备份仍在同一台 VPS 上；正式长期运行前应另行配置**加密的异机/离线副本、保留期限和定期恢复演练**。备份文件、口令与真实密钥绝不可入 Git 或聊天。
2. **生产兼容性：** 比对生产腾讯云 FastAPI/MCP 镜像实际代码与待发布 Web Worker 使用的 API/MCP 契约。若需要后端更新或 Schema 变更，应先获得独立的生产服务器操作授权、确定备份/回滚步骤，再按后端→Worker 的兼容顺序执行；不得默认 `main` push 会部署腾讯云。
3. **Cloudflare Dashboard 变量：** 生产 Worker 的 `ORIGIN_URL` 目前是 Dashboard 管理的普通变量，目标为 `https://origin-tasklutein.xswt.fyi`。仓库 `wrangler.jsonc` 通过 `keep_vars: true` 保留已有 Dashboard 变量；手工执行 `npm run deploy:worker` 时额外使用 `--keep-vars`。保留 secret binding `ORIGIN_GATEWAY_TOKEN`，不要导出其值。Cloudflare Git 自动部署命令可能仍为 `npx wrangler deploy`；必须在**计划发布的那个提交**中确认 Wrangler 解析到 `keep_vars: true`，并在部署后只读核对生产绑定名称、类型和非敏感回源 URL。不能把 dry-run 当成运行时配置验收。
4. **主分支触发器：** 先确认 Cloudflare Git Production 自动构建确实监控 `main`，收集旧 Worker deployment/version、当前生产健康状态及回滚步骤。合并 `dev` → `main` 与触发生产发布属于**同一有副作用的发布动作**，需维护者单独批准。
5. **上线后一跳一验：** 先只读校验 `/api/health` 返回 200、匿名 API 为 401、直连 Production Origin 为 403，再经授权执行真实 Web CRUD 和 MCP 工具测试；必须明确使用 Production 凭据和隔离的测试数据。若出现 503、鉴权失效或串环境，停止下一步，按既定版本与配置回滚并留存脱敏证据。

即使 `npm run check`、GitHub Actions 和 Preview 全绿，只要上述任何一项缺证据，不得宣称新版已上线。已有**单次**生产快照及隔离恢复通过；是否接受同主机快照作为首次上线回滚保障，由维护者决定，离线副本不应长期缺席。

生产备份脚本只能在 `tx-z02` 主机以 Docker 授权的维护账户执行（不是在本地 Windows Docker Engine 上执行）：

```bash
bash scripts/production-backup.sh
bash scripts/production-restore-check.sh "$HOME/backups/tasklutein-production/tasklutein-production-YYYYMMDDTHHMMSSZ.dump"
```

其中第二条的文件名取自第一条输出；运行前先把本仓库脚本安全传到服务器、确认来源与内容，不要重新初始化或覆盖现有部署。若从 Windows PowerShell 经 SSH 的标准输入直接传脚本，要防止 CRLF；可以在远程用 `tr -d '\r' | bash -s` 规范化行尾。两份脚本不收集 Token，恢复演练使用独立 `--network none` 容器，不对生产数据写入。


## GitHub Actions 分工（v0.1.0 起）

- **Check**（`check.yml`）：`main` / `dev` 的 push 与 PR 都执行代码校验，不部署。
- **Release**（`release.yml`）：仅在推送已验证的 `v*` 注释 Tag 时检查 Tag 与 `package.json`、中英文 Release Notes、`main` 祖先关系以及测试；检查通过才创建 GitHub Release，**不部署腾讯云或 Worker**。
- **Deploy Production Worker**（`deploy.yml`）：通过 GitHub Actions 在 `main` 上**手动运行**，使用名为 `production` 的 GitHub Environment；要求环境 Secret `CLOUDFLARE_API_TOKEN` 和仓库变量 `CLOUDFLARE_ACCOUNT_ID`。要求 Token 只具备目标账号 Workers Scripts/Assets 部署所需的最小权限，不要把本机 Wrangler OAuth Token 复制进 Actions。先运行 `npm run check`，部署时显式 `--keep-vars`，随后从 Cloudflare API 校验 Production Origin、Gateway Secret 绑定，并检查公网 200/401/403；只有该 Job 成功才记为成功的 GitHub Deployment。
- **首次接管注意：** 如果首次 Production Worker 是通过本机已有权限的 Wrangler 手工部署，应先核实实际 Cloudflare 部署版本和公网健康，再在 GitHub 创建与该真实版本相对应的 Deployment 记录；不能把一次 GitHub Release 或健康 200 伪装成新版已部署。Cloudflare Git 集成可能仍配置自动构建，但本项目的 GitHub Deploy Action **不会**因合并或推送 Tag 自动重复部署。

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
   - Cloudflare Worker：推荐在 GitHub Actions 手动运行 **Deploy Production Worker**（需要配置受限 Cloudflare API Token），或者在维护者本机明确授权后使用 `npm run deploy:worker`。两种方式都须检查 Dashboard `ORIGIN_URL` 保留且指向生产源站、`ORIGIN_GATEWAY_TOKEN` 仍为 Secret，确认 GitHub Deployment 记录与实际发布版本相对应。参见 [DEPLOYMENT.zh-CN.md](docs/development/DEPLOYMENT.zh-CN.md)。
   - 腾讯云：先备份 PostgreSQL，检查迁移兼容性，再更新 `tx-z02` 上的 Docker 镜像与 Compose 服务；勿在无确认时安装软件、修改安全组或停掉其他容器。
   - 线上核验：Web 登录/任务 CRUD/手机查看、API 401/403、源站直连拒绝、MCP tools/list 与报告写入、数据持久化、服务日志和监控。
8. 核对 GitHub Release、线上版本、变更记录与手动部署结果；若某一层发布失败，应记录状态，不允许把“GitHub Release 已创建”写成“服务已上线”。

## 安全与回滚

- **不提交** `testplace/`、任何 `.env`、`.dev.vars`、Cloudflare Tunnel Token、数据库备份或本地密钥。生产 Token 通过可信密钥管理/运行时环境配置，不能放到前端 `VITE_*` 变量。
- 没有自动数据库迁移：已有 PostgreSQL 数据时新增版本化迁移，并先确认备份与回滚方案；应用 Git 回滚不等于 Schema 回滚。
- Worker 与腾讯云是不同部署单元，需要分别记录上线成功与回滚方式；重放旧代码前确认 API/MCP 协议兼容。
- 不覆盖历史 Release 附件、不重写已有 Tag；修复后发布新版本。
- 尚未支持多用户账户、Agent OAuth 或精细化权限，Release Notes 必须如实披露。
