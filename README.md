<div align="center">
  <img src="icons/tasklutein-mark-transparent.svg" alt="Tasklutein 标志" width="88" height="88">
  <h1>Tasklutein</h1>
  <p><strong>让人和 AI Agent 共用同一份任务与进度</strong></p>
  <p>在浏览器管理任务，让 MCP Agent 查看任务并提交进度汇报。</p>
  <p>
    <a href="https://tasklutein.xswt.fyi">打开 Tasklutein</a> ·
    <a href="README.en.md">English</a> ·
    <a href="CHANGELOG.md">更新日志</a> ·
    <a href="LICENSE">MIT License</a>
  </p>
</div>

## 功能

- **任务管理**：创建、编辑和删除任务，按待处理、进行中和已完成筛选。
- **进度汇报**：为任务添加多条汇报，区分用户与 Agent 来源。
- **共享工作区**：在手机或桌面浏览器中查看同一组任务和进度。
- **MCP Agent**：通过 MCP 读取任务、更新状态并提交汇报。

## 开始使用

1. 打开 [Tasklutein 工作区](https://tasklutein.xswt.fyi)。
2. 输入工作区所有者提供的 Web 访问令牌。
3. 创建任务，填写说明，更新任务状态，并记录进展。

Web 令牌仅保存在当前浏览器会话中。重新打开工作区时，可能需要再次输入。

## 连接 MCP Agent

将 MCP 客户端连接到 `https://tasklutein.xswt.fyi/mcp`，并配置工作区所有者提供的 Agent 访问令牌。客户端需要支持自定义 `Authorization: Bearer` 请求头。

Agent 可使用以下工具：

- `list_tasks`：按状态筛选并列出任务。
- `get_task`：读取任务及其汇报。
- `create_task`：创建任务。
- `update_task`：修改任务标题、说明或状态。
- `add_report`：为任务添加进度汇报。

服务端根据已验证的令牌标记汇报来源。Agent 汇报记录工作活动，不代表结果已经过独立验收。

## 工作区访问范围

Tasklutein 当前使用一个共享工作区。Web 和 Agent 令牌分别签发，但都能访问该工作区的全部任务和汇报；令牌应只提供给受信任的使用者与 Agent。

目前不提供独立用户账户、按用户隔离的数据权限或 MCP OAuth 登录。

## 项目

[更新日志](CHANGELOG.md) · [MIT License](LICENSE)
