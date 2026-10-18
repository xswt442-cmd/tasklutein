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
| PATCH | `/api/agent-tokens/{uuid}` | 修改未撤销密钥的名称或到期时间 |
| DELETE | `/api/agent-tokens/{uuid}` | 撤销密钥并保留其元数据 |
| GET | `/api/agent/whoami` | 校验 Agent 密钥并返回其用户、工作区和密钥标识 |

`POST /api/agent-tokens` 接受 `{"name":"Build agent","expires_at":null}`。`name` 长度为 1–80 个字符；可选的 `expires_at` 必须是带时区且在未来的时间。成功返回 `201`，包含一次性明文 `secret` 和不含明文的 `token` 元数据。服务端只保存密钥摘要和显示前缀；明文只在创建响应中出现，之后不能通过 API 再次读取。元数据中的 `prefix` 固定为 `tlu_` 加密钥后 3 个字符；列表和更新响应不包含其余密钥字符、明文或摘要。列表包含 `id`、`name`、`prefix`、创建时间、到期时间和撤销时间，并继续列出已撤销密钥。`PATCH` 可分别更新 `name` 和 `expires_at`；将 `expires_at` 设为 `null` 表示永不过期。只有当前工作区的未撤销密钥可以更新；已撤销密钥返回 `409`，其他工作区的密钥返回 `404`。`DELETE` 执行软撤销并返回 `204`；列表仍保留该行并设置 `revoked_at`，重复撤销也是 `204`。

Agent 密钥只允许在 MCP 身份验证和 MCP 所调用的 API 中使用。通过 Web hostname 发起的 `/api/*` 请求按 Web 身份认证；该 hostname 不提供使用 Agent Bearer 密钥的公共 REST 登录方式。

## 任务 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，无需用户身份 |
| GET | `/api/ready` | 数据库就绪检查；需有效用户或 Agent 身份 |
| GET | `/api/overview` | 当前工作区的任务总数、状态分布和最近活动 |
| GET | `/api/tasks` | 筛选并分页查询当前工作区任务 |
| POST | `/api/tasks` | 在当前工作区创建任务 |
| GET | `/api/tasks/{uuid}` | 查询当前工作区中的任务 |
| PATCH | `/api/tasks/{uuid}` | 修改标题、说明或状态 |
| DELETE | `/api/tasks/{uuid}?history=keep` | 归档任务并保留任务快照、汇报和活动 |
| DELETE | `/api/tasks/{uuid}?history=delete` | 物理删除任务、汇报和活动 |

创建数据：

```json
{"title":"Fix release workflow","description":"Run CI and verify results","status":"todo"}
```

状态合法值：`todo`、`in_progress`、`done`。成功创建返回 `201` 和 `{"task":...}`；列表返回 `{"tasks":[],"total":0,"limit":25,"offset":0}`；详情与更新返回 `{"task":...}`；删除成功返回 `204`。不合法字段返回 `422`，当前工作区中不存在的任务返回 `404`。`done` 是任务状态，不表示归档。

当前任务接口、Overview、搜索和 MCP 任务工具只包含 `archived_at` 为空的任务。归档任务只能通过历史接口读取；通过当前任务或报告接口访问归档任务，以及访问其他工作区的任务，均返回 `404`。

列表可接收 `status`、`q`（标题和说明中的不区分大小写字面文本搜索，最多 200 字符）、`sort`（`updated_desc` 或 `created_desc`）、`limit`（1–200）与非负 `offset`。省略 `limit` 时最多返回 200 条。相同时间按 UUID 降序确定顺序。`total` 是匹配当前筛选条件的全部工作区任务数，与当前页无关。

`GET /api/overview` 返回 `total`、`by_status`、`recent_activities` 和 `generated_at`。状态计数覆盖当前工作区所有当前任务，而非最近 200 条；最近活动最多五条，并排除其他工作区记录。

## 汇报 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/{uuid}/reports` | 分页查询当前工作区任务的汇报 |
| POST | `/api/tasks/{uuid}/reports` | 追加汇报并返回 `201` |

请求体仅允许 `{"content":"..."}`。报告 `source`、用户归属和 Agent 密钥归属由 FastAPI 根据已验证身份写入，不接受客户端指定。创建响应的 `actor_name` 使用本次已验证身份的邮箱或 Agent Key 名称；后续读取会根据保存的操作者 ID 解析关联记录的当前邮箱或名称。改名或邮箱同步会改变既有报告的显示名称；系统不保存操作发生时的名称快照。迁移前缺少操作者归属的旧报告返回 `null`，界面只显示 `source`。汇报可接收 `limit`（1–100）与非负 `offset`；省略 `limit` 时最多返回 100 条。结果按 `created_at` 降序、再按 UUID 降序排序，响应包含 `total`、`limit` 和 `offset`。追加报告不会更改任务的 `updated_at`。

## 历史与活动 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/history/tasks` | 筛选并分页查询当前工作区的归档任务 |
| GET | `/api/history/tasks/{uuid}` | 只读查询归档时保存的完整任务字段 |
| GET | `/api/history/tasks/{uuid}/reports` | 只读分页查询归档任务的全部汇报 |
| DELETE | `/api/history/tasks/{uuid}` | 清理该任务的汇报与活动；归档任务同时彻底删除 |
| GET | `/api/activity` | 筛选并分页查询当前工作区的活动 |
| DELETE | `/api/activity/{event_id}` | 删除当前工作区中的单条活动 |

归档时间保存在任务行的 `archived_at`（UTC）字段；空值表示当前任务。归档会保留原任务 ID、全部任务字段、所有汇报和关联活动，归档后任务及汇报只读。`DELETE /api/tasks/{uuid}?history=keep` 归档任务并产生 `task.deleted` 活动；`history=delete` 物理删除该任务及其汇报和活动。省略 `history` 时沿用旧客户端行为，物理删除整组数据。删除整组历史时，若任务仍为当前任务，会保留任务本身及其状态，只清除全部汇报和活动；若任务已归档，则连同归档任务一并物理删除。对其他工作区的 ID 操作按 `404` 处理。历史和活动读取接口支持工作区内的 Web 用户及 Agent；删除任务、清理整组历史和删除单条活动要求已验证的 Web 用户身份。

`GET /api/history/tasks` 支持 `q`（标题和说明中的不区分大小写字面文本搜索，最多 200 字符）、`limit`（1–200，默认 25）和非负 `offset`；结果按归档时间降序、再按 UUID 降序排列。历史报告接口的 `limit` 为 1–100、默认 100，支持非负 `offset`；分页只限制本次读取，不会截断归档保存的数据。报告和活动响应中的 `actor_name` 是展示字段：读取时从当前关联用户邮箱或 Agent Key 名称解析，不是发生时的名称快照；名称或邮箱变化会反映到旧记录上。保存的用户/密钥 ID 关联用于标识实际操作者，旧报告无法确认的归属仍返回 `null`。`GET /api/activity` 支持 `source`（`user` 或 `agent`）、`event_type`、`task_id`、`limit`（1–100，默认 100）及非负 `offset`。响应活动记录包含 `actor_type` 和 `actor_name`。时间使用带时区的 UTC，活动按发生时间降序并以 UUID 降序稳定排序。历史和活动查询始终限定在调用者工作区。

活动类型为 `task.created`、`task.updated`、`task.status_changed`、`task.deleted` 和 `report.created`。每次实际任务或报告变更与对应活动在同一数据库事务中提交；活动写入失败时，业务变更也会回滚。状态发生变化的 PATCH 只产生一条 `task.status_changed`，摘要可以列出同次修改的其他字段；没有实际值变化的 PATCH 不更新时间，也不产生活动。活动摘要只保存受控的变更字段及状态前后值，不复制任务说明、报告正文或密钥。旧任务和报告不会补造活动，也不会根据 `updated_at` 推断过去发生的事件；旧报告无法确认的操作者保持未知。活动属于可删除的业务历史，不是不可篡改的安全审计日志。

任务更新、追加报告、归档和清理整组历史都会锁定目标任务并检查其归档状态。归档任务不能再通过当前任务或报告写入接口修改；任务操作与活动写入的事务保证两者保持一致。

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

可选本地 stdio MCP 适配器使用 `TASKLUTEIN_API_TOKEN` 配置个人 Agent 密钥，并通过 FastAPI REST API 访问当前工作区。现有任务 MCP 工具只处理当前任务，不返回或修改归档任务。

API 声明请求体超过 64 KiB 时返回 `413`；MCP 使用独立的 1 MiB 请求体限制。API 错误保留 `detail`，并包含 `code` 和 `request_id`。422 的 `detail` 是字段错误数组，不回显被拒绝的输入。每个 API 响应包含 `X-Request-ID`；Worker 转发前覆盖客户端提供的标识。日志只记录请求 ID、路由、方法、状态和耗时，不记录请求正文或凭据。常见状态包括身份缺失/无效 `401`、未授权或网关凭据无效 `403`、网关未配置或数据库不可用 `503`、参数错误 `422`、当前工作区记录不存在 `404`。公网 Worker 拒绝非白名单代理 Header 和源站 3xx 重定向。尚未实现细粒度角色权限、游标分页、接口限流、OAuth 和不可篡改的安全审计日志。

## 数据库升级兼容性

迁移不会随 API 启动自动执行。旧库升级时，先应用 `0002_identity_workspace`，让目标用户通过 Cloudflare Access 登录并建立个人工作区，再应用 `0003_task_workspace_required` 和 `0004_task_history`。若仍有旧共享工作区遗留的未归属任务，维护者须显式提供该用户的 Access issuer、subject、email 及确认值 `assign-existing-tasks`。迁移将所有未归属任务及其关联汇报保留到该单一工作区，不会推断或拆分归属。`0004_task_history` 将既有任务视为当前任务，不补造历史活动。首次归档后，旧版若忽略 `archived_at` 会重新显示归档任务，因此回退必须保留归档过滤与工作区隔离；移除历史 schema 需另行审查。完整迁移要求见[架构文档](ARCHITECTURE.zh-CN.md)。
