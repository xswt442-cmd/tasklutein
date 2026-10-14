# HTTP API 与 MCP 工具

[English](API.en.md) · 简体中文

## 公网入口与认证

所有公开地址使用同一个 Cloudflare Worker Hostname。网页静态资源位于 `/`；`/api/*` 转发到腾讯云 FastAPI；`/mcp` 转发到腾讯云 MCP HTTP Server。

Cloudflare Worker 以私密 `ORIGIN_GATEWAY_TOKEN` 注入 `X-Tasklutein-Gateway`，后端比对 `EDGE_GATEWAY_TOKEN`；客户端不应也无需提供此 Header。除了 `GET /api/health`，业务接口还要求 `Authorization: Bearer <TOKEN>`。网页用 `WEB_ACCESS_TOKEN`，Agent/API 用 `AGENT_ACCESS_TOKEN`；这两者当前都拥有**一个共享工作空间的全部读写权限**，不是多租户身份。

## 任务 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，无需用户 Bearer（仍需源站网关密钥） |
| GET | `/api/tasks` | 查询最近更新的前 200 个任务，支持 `?status=todo` |
| POST | `/api/tasks` | 创建任务 |
| GET | `/api/tasks/{uuid}` | 查询任务 |
| PATCH | `/api/tasks/{uuid}` | 修改标题、描述、状态 |
| DELETE | `/api/tasks/{uuid}` | 删除任务及其关联汇报 |

创建数据：

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

状态合法值：`todo`、`in_progress`、`done`。成功创建返回 `201` 和 `{"task":...}`；列表返回 `{"tasks":[...]}`。更新/详情返回 `{"task":...}`；删除成功 `204`。不合法字段 `422`，不存在的任务 `404`。

## 汇报 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | 最近的 100 条汇报 |
| POST | `/api/tasks/{uuid}/reports` | 追加汇报并返回 `201` |

请求体仅允许 `{"content":"..."}`；报告 `source` 由 FastAPI 根据已验证身份写为 `user` / `agent`，不是来自客户端 JSON。提交报告和修改任务状态是两次独立操作。

## 远程 MCP Streamable HTTP

地址：`https://tasklutein.<domain>/mcp`，由 Worker 路由到腾讯云 Docker 的 Node MCP Server。客户端必须支持自定义请求头 `Authorization: Bearer <AGENT_ACCESS_TOKEN>`，并与 MCP SDK 进行标准初始化握手。当前 HTTP 模式无状态，每个 POST 有独立 MCP Transport，返回 JSON，未实现会话恢复或 OAuth；GET/SSE 非必要，可能返回 `405`。不保证所有只支持 OAuth 或其他传输方式的 Agent 都能直接连接。

## MCP 工具与错误

| 工具 | 输入摘要 | 业务行为 |
| --- | --- | --- |
| `list_tasks` | 可选 status | 列出任务 |
| `get_task` | id (UUID) | 读取任务和汇报 |
| `create_task` | title、可选 description | 新建任务 |
| `update_task` | id、可选 title/description/status | 修改任务 |
| `add_report` | task_id、content | 追加 Agent 汇报 |

可选本地 stdio MCP 适配器提供相同工具集合，通过 HTTPS 调用 Worker 的 `/api/*`，也可在开发阶段访问本机 FastAPI。

HTTP 状态：缺少/错误业务 Token 为 `401`；请求缺少/错误源站网关密钥为 `403`；服务器未配置网关为 `503`；参数错误为 `422`；记录不存在为 `404`。公网 Worker 拒绝非白名单代理 Header 和 3xx 回源重定向。现在没有 RBAC、分页游标、接口限流、OAuth 或审计事件，不要把这些写为已完成功能。
