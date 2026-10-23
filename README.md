<div align="center">
  <img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein 标志" width="88" height="88">
  <h1>Tasklutein</h1>
  <p><strong>让人和 AI Agent 共用任务与进度</strong></p>
  <p>在浏览器管理个人工作区中的任务，让 MCP Agent 读取任务并提交进度汇报。</p>
  <p>
    <a href="https://tasklutein.xswt.fyi">打开 Tasklutein</a> ·
    <a href="README.en.md">English</a> ·
    <a href="LICENSE">MIT License</a>
  </p>
</div>

## 功能

- **个人工作区**：游客可浏览前端预览；通过 Cloudflare Access 登录后，每个用户有独立工作区。
- **任务管理**：创建、编辑并按需归档或彻底删除任务，按状态筛选、搜索、排序并分页浏览。
- **工作台与历史**：查看当前任务统计和近期活动；在历史页面只读查看完整归档任务及汇报，并清理单条或整组活动历史。
- **进度汇报与评论**：为任务添加多条汇报，并在每条汇报下添加平面评论；区分用户与 Agent 来源。
- **MCP Agent**：通过个人 Agent 密钥读取和更新所属工作区的任务、提交汇报。

## 开始使用

1. 打开 [Tasklutein](https://tasklutein.xswt.fyi) 浏览界面；登录 Cloudflare Access 后使用工作区功能。
2. 在工作台创建任务、更新状态并记录进展；需要移除任务时，可归档以保留历史，或彻底删除全部历史。
3. 如需连接 Agent，打开“设置”，创建个人 Agent 密钥并立即保存明文。密钥之后无法再次查看；可编辑名称和到期时间，也可永久删除。列表只显示 `tlu_` 和密钥后 3 个字符。删除会移除密钥记录，已有关联的汇报、评论和活动会保留，但不再显示密钥名称。

工作区由 Cloudflare Access 验证身份后自动建立。工作区按 Access 签发方和用户标识隔离；当前任务、归档历史、活动记录、统计和 Agent 密钥都限定在所属工作区内。

## 连接 MCP Agent

远程 MCP 使用部署配置的专用 MCP 主机，端点为 `https://<mcp-host>/mcp`。请在 MCP 客户端设置该 URL，并以 `Authorization: Bearer <个人 Agent 密钥>` 发送密钥。MCP 主机与 Web 主机分开；Web 主机上的 `/mcp` 不提供远程 MCP 服务。客户端需支持自定义 Authorization 请求头。

Agent 可使用以下工具：

- `list_tasks`：按状态或文本筛选并分页列出当前工作区任务。
- `list_reports`：分页读取任务汇报。
- `get_task`：读取任务及其汇报。
- `create_task`：创建任务。
- `update_task`：修改任务标题、说明或状态。
- `add_report`：为任务添加进度汇报。
- `list_report_comments`：分页读取汇报评论。
- `add_report_comment`：为汇报添加评论。

Agent 密钥仅访问创建者的个人工作区。服务端根据已验证的会话或密钥记录汇报来源；Agent 汇报记录工作活动，不代表结果已经过独立验收。

## 旧数据迁移

升级已有数据库时，原共享工作区中的未归属任务必须由维护者显式指定一个已通过 Cloudflare Access 登录并建立工作区的用户。迁移会将这些任务及其现有汇报一并保留在该用户工作区；不会自动拆分或猜测归属。迁移步骤和必要确认项见[架构文档](docs/development/ARCHITECTURE.zh-CN.md)。

## 文档

- [HTTP API 与 MCP 工具](docs/development/API.zh-CN.md)
- [架构](docs/development/ARCHITECTURE.zh-CN.md)

## 许可证

[MIT](LICENSE)
