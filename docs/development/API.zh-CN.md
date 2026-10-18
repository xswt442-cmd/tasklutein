# HTTP API 与 MCP 工具

[English](API.en.md) · 简体中文

## 公网入口与认证

Web 和远程 MCP 使用各自配置的 Cloudflare Worker hostname。Web 主机提供静态页面和 `/api/*`；MCP 主机只提供精确路径 `/mcp`，该主机上的其他路径返回 `404`。Web 主机上的 `/mcp` 不会转发到 MCP Server。使用部署配置中的 `<web-host>` 和 `<mcp-host>`，不要将两种入口混为一个 URL。

网页 API 请求依赖 Cloudflare Access。Worker 验证 Access JWT 后，将签发方、subject 和已验证邮箱作为内部身份 Header 转发给 FastAPI，并移除客户端伪造的同名 Header。除 `GET /api/health` 外，Web API 要求已建立的用户身份；首次进入时由 `POST /api/session/bootstrap` 建立用户和个人工作区。浏览器不发送业务 Bearer Token。

远程 MCP 客户端将个人 Agent 密钥作为 `Authorization: Bearer <AGENT_KEY>` 发送到 `https://<mcp-host>/mcp`。MCP Server 用该密钥调用 FastAPI；密钥对应的用户与个人工作区决定其可见数据。客户端不得提供 `X-Tasklutein-Gateway` 或内部身份 Header。Worker 注入 `ORIGIN_GATEWAY_TOKEN` 对应的网关 Header；FastAPI 与 MCP HTTP 通过 `EDGE_GATEWAY_TOKEN` 校验。

`GET /api/health` 不要求用户身份；`GET /api/ready` 要求已建立的 Web 身份或有效 Agent 密钥。除健康检查外，所有业务接口只读取或修改调用者工作区的数据。另一工作区中的任务按 `404` 处理。

## 会话与个人 Agent 密钥

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/session/bootstrap` | 根据 Worker 验证的 Access 身份建立或返回用户及个人工作区 |
| GET | `/api/me` | 返回当前用户及工作区；需要已建立的 Web 身份 |
| GET | `/api/agent-tokens` | 列出当前工作区的 Agent 密钥元数据 |
| POST | `/api/agent-tokens` | 创建个人 Agent 密钥 |
| DELETE | `/api/agent-tokens/{uuid}` | 撤销当前工作区中的密钥 |
| GET | `/api/agent/whoami` | 校验 Agent 密钥并返回其用户、工作区和密钥标识 |

`POST /api/agent-tokens` 接受 `{"name":"Build agent","expires_at":null}`。`name` 长度为 1–80 个字符；可选的 `expires_at` 必须是带时区且在未来的时间。成功返回 `201`，包含一次性明文 `secret` 和不含明文的 `token` 元数据。服务端只保存密钥摘要和显示前缀；之后不能通过 API 再次读取明文。列表中的元数据包含 `id`、`name`、`prefix`、创建时间、到期时间和撤销时间。撤销返回 `204`；不属于当前工作区的密钥按 `404` 处理。

Agent 密钥只允许在 MCP 身份验证和 MCP 所调用的 API 中使用。通过 Web hostname 发起的 `/api/*` 请求按 Web 身份认证；该 hostname 不提供使用 Agent Bearer 密钥的公共 REST 登录方式。

## 任务 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，无需用户身份 |
| GET | `/api/ready` | 数据库就绪检查；需有效用户或 Agent 身份 |
| GET | `/api/overview` | 当前工作区的任务总数与状态分布 |
| GET | `/api/tasks` | 筛选并分页查询当前工作区任务 |
| POST | `/api/tasks` | 在当前工作区创建任务 |
| GET | `/api/tasks/{uuid}` | 查询当前工作区中的任务 |
| PATCH | `/api/tasks/{uuid}` | 修改标题、说明或状态 |
| DELETE | `/api/tasks/{uuid}` | 删除任务及其关联汇报 |

创建数据：

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

状态合法值：`todo`、`in_progress`、`done`。成功创建返回 `201` 和 `{"task":...}`；列表返回 `{"tasks":[],"total":0,"limit":25,"offset":0}`；详情与更新返回 `{"task":...}`；删除成功返回 `204`。不合法字段返回 `422`，当前工作区中不存在的任务返回 `404`。

列表可接收 `status`、`q`（标题和说明中的不区分大小写字面文本搜索，最多 200 字符）、`sort`（`updated_desc` 或 `created_desc`）、`limit`（1–200）与非负 `offset`。省略 `limit` 时最多返回 200 条。相同时间按 UUID 降序确定顺序。`total` 是匹配当前筛选条件的全部工作区任务数，与当前页无关。

`GET /api/overview` 返回 `total`、`by_status` 和 `generated_at`。状态计数覆盖当前工作区所有任务，而非最近 200 条任务。

## 汇报 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | 分页查询当前工作区任务的汇报 |
| POST | `/api/tasks/{uuid}/reports` | 追加汇报并返回 `201` |

请求体仅允许 `{"content":"..."}`。报告 `source`、用户归属和 Agent 密钥归属由 FastAPI 根据已验证身份写入，不接受客户端指定。提交报告和修改任务状态是两次独立操作。汇报可接收 `limit`（1–100）与非负 `offset`；省略 `limit` 时最多返回 100 条。结果按 `created_at` 降序、再按 UUID 降序排序，响应包含 `total`、`limit` 和 `offset`。

## 远程 MCP Streamable HTTP

地址：`https://<mcp-host>/mcp`。Worker 仅在配置的 MCP hostname 上将精确路径 `/mcp` 路由到腾讯云 Docker 中的 Node MCP Server。客户端必须支持自定义请求头 `Authorization: Bearer <个人 Agent 密钥>`。锁文件当前解析到 `@modelcontextprotocol/sdk` 1.32.1；最高支持协议版本为 `2025-11-25`（含初始化握手），不声称兼容 `2026-07-28` 的新传输元数据 Header 与语义。HTTP 模式无状态，每个 POST 使用独立 MCP Transport 并返回 JSON，单请求体上限为 1 MiB。服务端只接受 POST；GET、DELETE 等方法返回 `405`。未实现会话恢复或 OAuth；只支持 OAuth 的 MCP 客户端可能无法连接。

## MCP 工具

| 工具 | 输入摘要 | 业务行为 |
| --- | --- | --- |
| `list_tasks` | 可选 status、q、sort、limit、offset | 搜索并分页列出密钥所属工作区的任务 |
| `list_reports` | task_id（UUID）、可选 limit/offset | 分页读取该工作区任务的汇报 |
| `get_task` | id（UUID） | 读取任务及其默认第一页汇报 |
| `create_task` | title、可选 description | 在密钥所属工作区新建任务 |
| `update_task` | id、可选 title/description/status | 修改该工作区任务 |
| `add_report` | task_id、content | 追加 Agent 汇报 |

可选本地 stdio MCP 适配器使用 `TASKLUTEIN_API_TOKEN` 配置个人 Agent 密钥，并通过 FastAPI REST API 访问当前工作区。

API 声明请求体超过 64 KiB 时返回 `413`；MCP 使用独立的 1 MiB 请求体限制。API 错误保留 `detail`，并包含 `code` 和 `request_id`。422 的 `detail` 是字段错误数组，不回显被拒绝的输入。每个 API 响应包含 `X-Request-ID`；Worker 转发前覆盖客户端提供的标识。日志只记录请求 ID、路由、方法、状态和耗时，不记录请求正文或凭据。常见状态包括身份缺失/无效 `401`、未授权或网关凭据无效 `403`、网关未配置或数据库不可用 `503`、参数错误 `422`、当前工作区记录不存在 `404`。公网 Worker 拒绝非白名单代理 Header 和源站 3xx 重定向。尚未实现细粒度角色权限、游标分页、接口限流、OAuth 和业务审计日志。

## 数据库升级兼容性

迁移不会随 API 启动自动执行。旧库升级时，先应用 `0002_identity_workspace`，让目标用户通过 Cloudflare Access 登录并建立个人工作区，再应用 `0003_task_workspace_required`。若仍有旧共享工作区遗留的未归属任务，维护者须显式提供该用户的 Access issuer、subject、email 及确认值 `assign-existing-tasks`。迁移将所有未归属任务及其关联汇报保留到该单一工作区，不会推断或拆分归属。既有汇报的来源和内容保留，但其用户与 Agent 密钥归属仍为空。完整迁移要求见[架构文档](ARCHITECTURE.zh-CN.md)。
