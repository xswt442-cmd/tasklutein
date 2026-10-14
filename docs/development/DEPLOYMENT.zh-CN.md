# 部署与集成

[English](DEPLOYMENT.en.md) · 简体中文

## 目标拓扑与前提

**Cloudflare Worker** 提供 React 页面、`/api/*` 与 `/mcp` 公网网关。**腾讯云 `tx-z02`** 运行 Docker 下的 FastAPI、PostgreSQL 和远程 MCP Server，Caddy 负责内网路径分流，Cloudflare Tunnel 将 HTTPS 源站请求转给 Caddy。业务数据始终留在腾讯云。

当前只是仓库中的部署配置，**没有自动创建云端资源、部署生产服务或保存真实密钥**。Node.js 24+ 构建 Worker，Ubuntu 服务器需要 Docker Engine + Docker Compose v2。只读检查过 `tx-z02`：Ubuntu 24.04，已有 Docker Engine，但当时缺少 Compose v2 插件；先确认状态再安装。

规划两个不同域名，不能让源站域名也路由到 Worker：
- **公开应用：** `https://tasklutein.<domain>`（Worker；页面、`/api/*`、`/mcp`）。
- **Tunnel 源站：** `https://origin-tasklutein.<domain>`（仅供 Worker 回源，强制网关密钥）。

## 第一步：初始化腾讯云 Docker

**不在本指南中自动 SSH 或安装软件**。在 `ssh tx-z02` 登录后，如 `docker compose version` 不存在，由服务器管理员安装：

```sh
sudo apt-get update
sudo apt-get install -y docker-compose-v2
docker compose version
```

先将经过 CI 验证的代码提交并推送至 `main`，然后部署到服务器：

```sh
mkdir -p ~/apps
git clone --branch main https://github.com/xswt442-cmd/tasklutein.git ~/apps/tasklutein
cd ~/apps/tasklutein/deploy
cp .env.example .env
chmod 600 .env
```

编辑 `deploy/.env`，用 `openssl rand -hex 32` 分别生成 **4 个不同**的 `POSTGRES_PASSWORD`、`WEB_ACCESS_TOKEN`、`AGENT_ACCESS_TOKEN`、`EDGE_GATEWAY_TOKEN`。不要使用示例中的 `REPLACE_WITH_...` 值。可先将 `CF_TUNNEL_TOKEN` 留空。

```sh
cd ~/apps/tasklutein/deploy
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build db api mcp router
docker compose --env-file .env ps
```

`api` 绑定宿主 `127.0.0.1:8000`、`router` 绑定 `127.0.0.1:8080`，PostgreSQL 只绑定 `127.0.0.1:55432`，远程 MCP 端口只在 Docker 内部。腾讯云安全组**不要放行** 8000/8080/55432/3000。Docker 数据卷保存 PostgreSQL 数据；`migrations/0001_init.sql` 只在空数据卷第一次启动时运行，后续 Schema 变更须新增迁移并先备份。

API 在生产环境要求网关密钥，直接 `curl http://127.0.0.1:8000/api/health` 返回 403 是预期行为。可在本地验证时由 shell 安全地读取网关密钥并携带 `X-Tasklutein-Gateway` Header，但不要在命令历史或日志中打印密钥。

## 第二步：初始化 Cloudflare Tunnel

Cloudflare Dashboard → Zero Trust → Networks → Tunnels → Create Tunnel，选择 `cloudflared` (Docker)。将云端提供的 Tunnel Token 写入服务器 `deploy/.env` 的 `CF_TUNNEL_TOKEN`，不写入 Git 或浏览器配置。

为这个 Tunnel 增加公开 Hostname `origin-tasklutein.<domain>`，HTTP Service URL **`http://router:8080`**（运行在同一个 Docker Compose 网络里）。确认域名的 DNS/Tunnel 路由生效。

```sh
cd ~/apps/tasklutein/deploy
docker compose --env-file .env --profile tunnel up -d
docker compose --env-file .env --profile tunnel ps
```

**源站 Hostname 本身可在互联网上访问，但不能绕开网关认证。** 直接请求源站 `/api/health` 预期被拒绝（403），MCP 请求也需要额外的 Agent Bearer Token；Cloudflare Tunnel 不替代业务认证。后续可再配置 Cloudflare Access Service Token 作为额外防线，但这需要同步给 Worker 配置，不在当前 MVP 自动实现。

## 第三步：初始化 Cloudflare Worker

仓库根目录已经有 `wrangler.jsonc`：Worker 名为 `tasklutein`，入口 `apps/edge/src/index.ts`，静态资源 `apps/web/dist`，按 `/api/*` 与 `/mcp` 先运行 Worker；无关路径交给 Assets，SPA fallback 已配置。**不要再创建 Pages 项目**，这是一个完整 Worker + Assets 部署。

两种初始化方式二选一：

1. **推荐 Git 集成：** Cloudflare Dashboard → Workers & Pages → Create Worker → Connect to Git，选择 `xswt442-cmd/tasklutein`，Root 为仓库根目录，构建命令 `npm ci && npm run build:web`，部署命令 `npx wrangler deploy`，生产分支选 `main`。
2. **本机手动初始化：** 在仓库根目录运行 `npx wrangler login`（需要你本人在浏览器授权），然后 `npm ci`、`npm run build:web`、`npx wrangler deploy`。首次部署将根据 wrangler 配置创建/更新同名 Worker；不要再重复创建 Git 项目。

在 Cloudflare Worker 的 Runtime Settings / Variables and Secrets 中配置：

| 配置名 | 位置 | 示例 |
| --- | --- | --- |
| `ORIGIN_URL` | Worker runtime variable | `https://origin-tasklutein.<domain>` |
| `ORIGIN_GATEWAY_TOKEN` | Worker **Secret** | 必须与腾讯云 `EDGE_GATEWAY_TOKEN` 完全相同 |

可以用 `npx wrangler secret put ORIGIN_GATEWAY_TOKEN` 交互式输入密钥；绝不把 Token 写入 `wrangler.jsonc` 的公开 `vars`，也不要写到 `VITE_*` 构建变量。使用 Git 自动部署时，确认目标 Worker 的运行时密钥会在下一次部署中保留。

将公开的 Worker 绑定自定义域名 `tasklutein.<domain>`，或先使用 `*.workers.dev` 测试。浏览器访问页面并请求**同源**的 `/api/*`；不再配置 `VITE_API_BASE_URL`，也无需浏览器跨域访问腾讯云。

## 第四步：本地 Worker 和 MCP 联调

在 Windows 本地仓库可先运行 `npm ci`、`npm run check`；Worker 产物由 `npm run build:web` 构建，`npm run build:worker` 仅校验本地打包，不创建云端资源。

若本地有 Docker Compose，复制 `deploy/.env.example` 为私有 `deploy/.env`，按同样方式配置密钥并启动 `db api mcp router`。再复制仓库根目录 `.dev.vars.example` 为 `.dev.vars`：
- `ORIGIN_URL=http://127.0.0.1:8080`（仅本机开发允许 HTTP）。
- `ORIGIN_GATEWAY_TOKEN` 与本地 `deploy/.env` 中的 `EDGE_GATEWAY_TOKEN` 相同。

```powershell
npm run dev:worker
```

测试 `http://127.0.0.1:8787/api/health`，再带 Web Token 请求任务接口。Vite 的 `npm run dev` 模式保留快速前端开发路径，直接代理本地 FastAPI，要求本地 FastAPI 开发环境未设置 `EDGE_GATEWAY_TOKEN`；它不能替代完整 Worker/Tunnel 联调。

## 第五步：公网验收与 MCP 客户端

先检查 `https://tasklutein.<domain>/api/health` 返回健康状态，而直接访问 `https://origin-tasklutein.<domain>/api/health` 返回 403。再确认 `/api/tasks` 未带 Bearer 返回 401；带有效 `WEB_ACCESS_TOKEN` 可以执行任务 CRUD，在手机上刷新能看到持久化数据。

远程 MCP 地址：**`https://tasklutein.<domain>/mcp`**，使用 HTTP Streamable MCP，客户端必须在请求中添加 `Authorization: Bearer <AGENT_ACCESS_TOKEN>`。远程 MCP 运行在腾讯云 Node 容器中，Worker 只是透明路由，不做 MCP 工具执行。支持自定义请求头的 MCP 客户端可配置该 URL；OAuth-only 客户端当前无法直接连接。

本地 stdio MCP 仍支持 `npm run mcp`，将 `TASKLUTEIN_API_BASE` 设为公开 Worker 站点（不带 `/api`），将 `TASKLUTEIN_API_TOKEN` 设为 Agent Token。不要在 Agent 提示词或提交到 Git 的客户端配置中放真实密钥。

## 同时运行 main 生产站和 dev Preview

生产和预览应使用两个 Worker：Production `tasklutein` 发布 `main`，Preview `tasklutein-preview` 发布 `dev`。本次 Cloudflare 盘点发现 `preview.tasklutein.xswt.fyi` 当前指向生产 Worker，所以不能把它当成 dev Preview。仓库现有 `wrangler.jsonc` 的 Worker 名是 `tasklutein`；新的 `wrangler.preview.jsonc` 使用不同名称 `tasklutein-preview`。不要把 dev 用生产配置部署。

仓库的 Cloudflare Workers Builds 保持生产分支 `main` 和生产部署命令不变；Preview Build 命令使用 `npm ci && npm run build:web` 与 `npx wrangler deploy --config wrangler.preview.jsonc`。因此 Preview 构建部署到独立的 `tasklutein-preview` Worker，而不是覆盖生产 `tasklutein`。先用 `tasklutein-preview.<account>.workers.dev` 验证预览 Worker，再把自定义域名 `preview.tasklutein.xswt.fyi` 从生产 Worker 有计划地迁移到 `tasklutein-preview`。迁移前确认预览后端、Worker 变量和 Secret 均已就绪，并记录原绑定以便回退。

在服务器保留生产目录 `~/apps/tasklutein` 不动，另建 `dev` 工作目录和独立 Compose 项目：

```sh
git clone --branch dev https://github.com/xswt442-cmd/tasklutein.git ~/apps/tasklutein-preview
cd ~/apps/tasklutein-preview/deploy
cp .env.preview.example .env.preview
chmod 600 .env.preview
```

编辑 `.env.preview`：分别为 `POSTGRES_PASSWORD`、`WEB_ACCESS_TOKEN`、`AGENT_ACCESS_TOKEN`、`EDGE_GATEWAY_TOKEN` 生成全新的随机值，不能复用生产密钥。保留示例中的独立端口 `55433`、`8001`、`8081`。仅在 Cloudflare Preview 后端 Tunnel 已创建后填入该 Tunnel 的 `CF_TUNNEL_TOKEN`。

Cloudflare Zero Trust 中创建**第二个独立 Tunnel**，公开主机名设为 `preview.origin-tasklutein.xswt.fyi`，服务指向 `http://router:8080`。然后启动只属于 Preview 的服务和数据库：

```sh
cd ~/apps/tasklutein-preview/deploy
docker compose --project-name tasklutein-preview --env-file .env.preview config --quiet
docker compose --project-name tasklutein-preview --env-file .env.preview up -d --build db api mcp router
docker compose --project-name tasklutein-preview --env-file .env.preview --profile tunnel up -d tunnel
docker compose --project-name tasklutein-preview --env-file .env.preview ps
```

Compose 项目名会创建独立网络和带 `tasklutein-preview_` 前缀的数据卷；Preview 数据库只绑定回环地址 `127.0.0.1:55433`，不对公网开放。更新预览时只在 `~/apps/tasklutein-preview` 执行 `git pull --ff-only`，再用同一项目名执行 `docker compose --project-name tasklutein-preview --env-file .env.preview up -d --build`；不要在生产目录运行这组命令。

Cloudflare Dashboard → 对应 Worker → Settings → Variables and Secrets，分别配置：

| 环境 | `ORIGIN_URL` 普通变量 | `ORIGIN_GATEWAY_TOKEN` Secret |
| --- | --- | --- |
| Production | `https://origin-tasklutein.xswt.fyi` | 与生产 `.env` 的 `EDGE_GATEWAY_TOKEN` 完全相同 |
| `tasklutein-preview` Production 环境 | `https://preview.origin-tasklutein.xswt.fyi` | 与 Preview `.env.preview` 的 `EDGE_GATEWAY_TOKEN` 完全相同 |

两个 Worker 都使用 `ORIGIN_URL` 和 Secret `ORIGIN_GATEWAY_TOKEN`，但分别配置对应环境的值。截图里的 `ORIGIN_PREVIEW_URL` 不会被 Worker 读取，应删除或改为 `ORIGIN_URL`。不要把网关 Token 放入普通变量、构建变量或仓库。不要依赖生产 Worker 的 Preview Base 来提供域名隔离；本方案使用独立 Worker 和独立凭据。

确认 `tasklutein-preview` 的 Build 只从 `dev` 部署。推送 `dev` 后检查：Production `https://tasklutein.xswt.fyi/api/health` 与 Preview `https://preview.tasklutein.xswt.fyi/api/health` 均返回健康状态；Preview 创建的任务只能在 Preview 站点看到，Production 数据不变。源站地址的 `/api/health` 应直接返回 403。两套 Worker、数据库和应用 Token 相互独立。

## 更新、回滚与安全清单

采用 `dev` 日常开发和 Preview、`main` 生产发布。GitHub Actions 的 `check.yml` 执行 CI；`release.yml` 在显式推送合规 Tag 后创建 GitHub Release，但**不会发布 Worker、不会 SSH 部署腾讯云**。维护者发布顺序与回滚规则详见 [`RELEASE.md`](../../RELEASE.md)。上线前 PR、`npm run check`、后端 pytest/Ruff、真实 PostgreSQL/MCP 联调都应通过。生产服务器更新需要人工在生产目录执行 `git pull --ff-only` 和 `docker compose --env-file .env up -d --build`；Preview 服务器目录必须单独更新 `dev`，使用 `tasklutein-preview` 项目名。Worker 可交给 Cloudflare Git 集成，或人工运行 `npx wrangler deploy`。

数据库升级前备份 PostgreSQL；应用回滚不会自动回滚 Schema。公网部署还需设置 Cloudflare Rate Limiting/WAF、合理的日志脱敏、密钥轮换策略和告警。当前没有多用户身份、MCP OAuth、自动 Token 轮换或生产迁移编排，不要在 CV/README 中声称已经实现。
