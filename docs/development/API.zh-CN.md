# HTTP API 与 MCP 工具

[English](API.en.md) · 简体中文

## 公网入口与认证

所有公开地址使用同一个 Cloudflare Worker Hostname。网页静态资源位于 `/`；`/api/*` 转发到腾讯云 FastAPI；`/mcp` 转发到腾讯云 MCP HTTP Server。

Cloudflare Worker 以私密 `ORIGIN_GATEWAY_TOKEN` 注入 `X-Tasklutein-Gateway`，后端比对 `EDGE_GATEWAY_TOKEN`；客户端不应也无需提供此 Header。除了 `GET /api/health`，业务接口还要求 `Authorization: Bearer <TOKEN>`。网页用 `WEB_ACCESS_TOKEN`，Agent/API 用 `AGENT_ACCESS_TOKEN`；这两者当前都拥有**一个共享工作空间的全部读写权限**，不是多租户身份。

## 任务 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，无需用户 Bearer（仍需源站网关密钥） |
| GET | `/api/ready` | 数据库就绪检查；需要网关与业务 Bearer 令牌 |
| GET | `/api/overview` | 全工作区任务总数与状态分布 |
| GET | `/api/tasks` | 筛选并分页查询任务；省略 `limit` 时最多 200 条 |
| POST | `/api/tasks` | 创建任务 |
| GET | `/api/tasks/{uuid}` | 查询任务 |
| PATCH | `/api/tasks/{uuid}` | 修改标题、描述、状态 |
| DELETE | `/api/tasks/{uuid}` | 删除任务及其关联汇报 |

创建数据：

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

状态合法值：`todo`、`in_progress`、`done`。成功创建返回 `201` 和 `{"task":...}`；列表返回 `{"tasks":[],"total":0,"limit":25,"offset":0}`；更新/详情返回 `{"task":...}`；删除成功 `204`。不合法字段 `422`，不存在的任务 `404`。

列表可接收 `status`、`q`（标题和说明中的不区分大小写字面文本搜索，最多 200 字符）、`sort`（`updated_desc` 或 `created_desc`）、`limit`（1–200）与非负 `offset`。省略 `limit` 时保留原来的最多 200 条响应；新调用方应明确设置页大小。相同时间按 UUID 降序确定顺序。`total` 是符合筛选条件的全部任务数，与当前页无关。

`GET /api/overview` 返回 `total`、`by_status` 和 `generated_at`。状态数量统计整个共享工作区，而非最近的 200 条任务。

## 汇报 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | 分页查询汇报；省略 `limit` 时最多 100 条 |
| POST | `/api/tasks/{uuid}/reports` | 追加汇报并返回 `201` |

请求体仅允许 `{"content":"..."}`；报告 `source` 由 FastAPI 根据已验证身份写为 `user` / `agent`，不是来自客户端 JSON。提交报告和修改任务状态是两次独立操作。汇报可接收 `limit`（1–100）与非负 `offset`；省略 `limit` 时保留原来的最多 100 条响应。结果先按 `created_at`、再按 UUID 降序排序，响应包含 `total`、`limit` 和 `offset`。

## 远程 MCP Streamable HTTP

地址：`https://tasklutein.<domain>/mcp`，由 Worker 路由到腾讯云 Docker 的 Node MCP Server。客户端必须支持自定义请求头 `Authorization: Bearer <AGENT_ACCESS_TOKEN>`。锁文件当前解析到 `@modelcontextprotocol/sdk` 1.32.1，最高支持协议版本为 `2025-11-25`（含初始化握手）；不声称兼容 `2026-07-28` 的新传输元数据头与语义。当前 HTTP 模式无状态，每个 POST 有独立 MCP Transport，返回 JSON，单请求体上限 1 MiB；未实现会话恢复或 OAuth。服务端只接受 POST；GET、DELETE 等方法返回 `405`。不保证所有只支持 OAuth 或其他传输方式的 Agent 都能直接连接。

## MCP 工具与错误

| 工具 | 输入摘要 | 业务行为 |
| --- | --- | --- |
| `list_tasks` | 可选 status、q、sort、limit、offset | 搜索并分页列出任务 |
| `list_reports` | task_id（UUID）、可选 limit/offset | 分页读取汇报 |
| `get_task` | id (UUID) | 读取任务和汇报 |
| `create_task` | title、可选 description | 新建任务 |
| `update_task` | id、可选 title/description/status | 修改任务 |
| `add_report` | task_id、content | 追加 Agent 汇报 |

可选本地 stdio MCP 适配器提供相同工具集合，通过 HTTPS 调用 Worker 的 `/api/*`，也可在开发阶段访问本机 FastAPI。

声明大小超过 64 KiB 的 API 请求体会返回 `413`；MCP 使用独立的 1 MiB 请求体限制。API 错误保留 `detail`，并增加稳定的 `code` 和 `request_id`。422 的 `detail` 仍是字段错误数组，但不会回显被拒绝的输入。每个 API 响应包含 `X-Request-ID`；Worker 转发前会覆盖客户端提供的标识。日志只记录请求 ID、路由、方法、状态和耗时，不记录请求正文或凭据。HTTP 状态包括业务 Token 缺失/错误 `401`、源站密钥缺失/错误 `403`、网关未配置或数据库不可用 `503`、参数错误 `422`、记录不存在 `404`。公网 Worker 拒绝非白名单代理 Header 和 3xx 回源重定向。RBAC、游标分页、接口限流、OAuth 和业务审计日志尚未实现。
