# 现有仓库迁移与验收清单

## 1. 实施顺序

1. **盘点**当前分支、Git 跟踪文件、文档、标签、发布渠道、CI 和 .gitignore。
2. **归类**各文件内容的权威位置；找出被重复维护的说明。
3. **清理**私人路径、环境专属状态、开发流水与未来任务；同步移除注释中的旧方案与修复经过。以当前代码和文件为准，保留真实功能及必要安全/升级限制。
4. **统一入口**：AGENTS、PR 模板、CHANGELOG、RELEASE 操作手册及相应的语言命名。
5. **改造发布**：GitHub Release 正文从 Tag 对应 CHANGELOG 自动生成，取消新版本单独手写 Release Notes。
6. **检查**语义、文件链接、Release 生成脚本、单元测试与 CI；再根据维护者授权提交。
7. **逐步接入其他仓库**；先治理现状，再考虑扩展检查脚本，避免一次性跨仓库大改。

## 2. 规范源与项目副本

规范权威源由维护者在独立的工程规范仓库中维护；本目录是当前项目的独立副本。产品仓库中的 PR 模板、PR Skill 与工程规则是经过各项目审查的本地副本；产品文档必须可独立阅读，不要求贡献者能访问私有规范源。不要让各项目各自修改独立的“全局标准”。

对采用统一 PR 模板的仓库，可从权威规范仓库根目录运行：

~~~sh
node .github/engineering/scripts/sync-pr.mjs --check /path/to/repo
node .github/engineering/scripts/sync-pr.mjs --apply /path/to/repo
~~~

该脚本仅同步 PR 模板与 PR Skill 的四个指定文件；只读检查发现差异时退出非零，写入必须使用 `--apply`，且拒绝覆盖目标仓库已经修改或未跟踪的文件。同步完成后仍由项目维护者审查 Diff、运行检查、决定是否提交与推送。

## 3. 检查表

| 目标 | 完成条件 |
| --- | --- |
| 文件内容 | 没有真实个人目录、私人 SSH 别名、仅本机可用配置、秘密或一次性部署流水 |
| README | 面向使用者，功能与支持范围真实、语言精简；无重构动机、Agent 日志、内部任务列表或未来功能宣传 |
| CHANGELOG | 每版本双语，按，不预留空类别；仅记录已实现变化及必要兼容性影响 |
| Release | 从 Tag 的 CHANGELOG 派生正文，必要安装内容来自已验证资产 |
| RELEASE.md | 只有可重复的发布验证和回滚步骤 |
| ARCHITECTURE | 反映当前代码边界，没有过期环境快照 |
| API / DEPLOYMENT | 例子可迁移、操作有效，删除单次验证输出 |
| GLOSSARY | 只有实际需要定义的领域术语 |
| AGENTS | 全英文、无私人环境信息；仅包含当前工程边界、可迁移测试命令和授权规则。根目录规则普适，子目录规则局部适用 |
| CLAUDE | 仅引用同目录 AGENTS.md，无需重复维护工程规则 |
| PR | 简体中文“变更 / 任务 / 验证”与英文“Changes / Tasks / Verification”成对；任务用真实完成的 `- [x]` 勾选项，验证记录实际通过的检查，不写未来待办 |
| Issues | 接收独立任务、计划与讨论 |
| testplace | 被 Git 忽略，未误纳入暂存和历史发布资产 |
| 文档与注释 | 正确表述当前最终状态；正文不记调试历程，注释只解释当前约束，语句清楚，图示按需使用 Mermaid |
| 文档组织 | 根目录只保留标准入口，其他文档按职责归档；没有需要依赖的私人外部文件 |
| CI / 安全 | 文档基础检查、版本对应验证、仓库 Secret Scan 和真实功能测试 |

## 4. 不同发行形式

### 单产品 Web + API + MCP

- 根目录 CHANGELOG 对应 `vX.Y.Z`。
- Worker、API、MCP、数据库可以是不同发布单元；GitHub Release 只代表代码版本及发行公告。
- RELEASE 与 DEPLOYMENT 保留通用分层发布、迁移和恢复步骤，不复制某次服务器状态。

### 桌面应用

- 一个产品版本可有多个平台安装包；生成 Release 时，下载安装指引和文件名来自真实资产验证清单。
- 保留现有平台构建与签名边界；统一 CHANGELOG 来源不要求重做打包流水。

### 多发行产品仓库

- 每个独立产品维护自己的版本清单、CHANGELOG 和 Tag 前缀。
- 共享代码变化只在实际包含它的发行产品版本中记录；不要合并成一个虚假的仓库大版本。

## 5. Release 提取脚本

权威源提供 `.github/engineering/scripts/release-notes.mjs` 作为可复用脚本。按项目实际发行流程审查并复制到目标仓库的 `scripts/release-notes.mjs` 后，从该 Tag 对应的源码检出目录运行：

~~~sh
node scripts/release-notes.mjs --changelog CHANGELOG.md --tag v1.2.3
node scripts/release-notes.mjs --changelog tui/CHANGELOG.md --tag cli-v1.2.3 --manifest tui/package.json
~~~

脚本只读取本地文件并将 Release 正文写入标准输出；不创建 Tag、提交、调用 GitHub、上传资产或部署服务。工作流应将结果保存为构建临时文件，再传给 GitHub Release CLI 的 `--notes-file`。

## 6. 历史版本

- 不移动或强制更新已发布 Tag，不覆盖既有 Release 安装包。
- 维护当前分支 CHANGELOG 时，可剔除旧版本条目中的过程日志，保留真实交付变化、限制与升级条件。
- 旧 Release 已经公开的正文没有必要为统一格式全部改写；如需纠正客观错误，按该项目正式修订程序处理。
- 仓库治理需要提交时仍按具体仓库权限与维护者授权执行。
