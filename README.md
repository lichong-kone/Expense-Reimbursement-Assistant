# Expense Reimbursement Assistant（报销助手 · 使用指南）

面向使用者的**公开使用文档**：如何通过网页、服务型 Skill（MCP）或通用 Skill 完成报销信息的整理、审核与文档生成。

> ⚠️ **域名可能变更**：下文出现的服务地址（当前为 `https://metagentictool.com`）可能会调整。**如果链接访问不了，请回到本仓库根目录的本 `README.md` 查看最新地址与说明**——本文件会随地址变化更新。
>
> 本仓库只包含**使用说明**。公司官方报销模板、内部政策原文、物理字段映射与后端服务代码属于受控资产，**不在本仓库内**，仅在公司内部渠道提供。

---

## 三种使用方式，怎么选

| 你的情况 | 使用方式 | 依赖 |
| --- | --- | --- |
| 想直接用现成网页完成报销整理 | **网页（Web）** | 浏览器 + 账号 |
| 用支持 MCP 的 Agent（Claude Desktop、Cline、WorkBuddy 等）在线全流程 | **服务型 Skill + MCP** | Node 18+、可访问服务地址 |
| 用任意 Agent，离线/平台中立地整理与审核报销资料 | **通用 Skill** | Node 18+ |

---

## 一、网页（Web）使用方式

1. 用浏览器打开服务地址（当前：`https://metagentictool.com`）。
2. 注册 / 登录账号。
3. 绑定邮箱（IMAP）：在设置中填写邮箱与授权码，系统据此收取报销相关发票邮件。
4. 同步发票：手动“立即同步”或按设置的频率自动增量拉取。
5. 整理与确认：系统自动识别发票字段并归类；对存疑/缺字段/疑似重复项，按提示确认或补充。
6. 政策提示：系统展示超标/超期/缺件等提示（仅提示，可按需处理）。
7. 建单与导出：创建报销单、分配发票，最后导出公司格式的报销文件。

> 账号密码、邮箱授权码等只在网页安全输入，不要写入聊天、截图或公开渠道。

---

## 二、服务型 Skill + MCP 使用方式（在线全流程）

适合支持 [MCP](https://modelcontextprotocol.io) 的 Agent 客户端，连接现成的后端服务完成在线全流程。

### 1. 前置条件

- Node.js **18+**：`node --version`
- 一个 MCP 客户端：Claude Desktop、Cline、Continue、WorkBuddy 或自研 Agent
- 客户端可访问服务地址（当前 `https://metagentictool.com`）

### 2. 在 MCP 客户端中添加服务

把下面配置合并到客户端的 `mcpServers` 设置（使用固定版本 URL）：

```json
{
  "mcpServers": {
    "rebu": {
      "command": "npx",
      "args": ["-y", "https://metagentictool.com/downloads/rebu-mcp-1.1.3.tgz"],
      "env": { "REBU_API_BASE": "https://metagentictool.com" }
    }
  }
}
```

常见配置入口：

- **Claude Desktop（macOS）**：`~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop（Windows）**：`%APPDATA%\Claude\claude_desktop_config.json`
- **Cline / Continue**：扩展的 MCP Server 设置
- **WorkBuddy / 自研宿主**：添加 stdio MCP Server，填入上方 `command`、`args`、`env`

保存后重启客户端，应看到 `rebu` 服务和 `rebu_*` 工具。

> 若上面的下载地址或 `REBU_API_BASE` 访问不了，说明服务地址已变更——请回到本仓库根 `README.md` 查看最新地址。

### 3. 开始使用

连接后可直接说：

```text
连接报销服务：先检查我的配置和待办，再同步最近的报销发票。
```

流程会在批量处理前说明范围和撤销方式，并以“**已自动处理 / 仍需决定 / 下一步**”交付结果；需要你确认的事项用统一动作：`keep`（保留）/ `adjust`（调整）/ `exempt`（豁免并说明原因）/ `provide_info`（补充信息）/ `defer`（稍后处理）。

### 4. 凭据安全

配置里只需要 `REBU_API_BASE`。账号密码、IMAP 授权码、令牌等**不要写进配置文件、聊天或公开渠道**；如宿主支持，请用 Secret Store / 安全输入面板 / 受保护环境变量提供。

---

## 三、通用 Skill 使用方式（平台中立）

“通用 Skill”是一个平台中立的 **Agent Skill**：一个带 YAML frontmatter（`name`、`description`）的 `SKILL.md` 加同目录的逻辑/资源文件。任何支持 Skill 的 Agent 装上后，用 Agent 自身能力（读邮件、下载附件、解析 PDF/OFD/XML、OCR）配合 Skill 内置的**政策、整理与审核逻辑**，即可完成报销信息整理与结构化结果输出。

### 什么是“安装 Skill”

安装就是把该 Skill 目录放到你的 Agent 宿主会读取 skills 的位置。不同宿主目录不同：

- **Kiro**：`~/.kiro/skills/`
- **部分宿主**：`~/.agents/skills/`
- **其他**：用宿主自带的“导入 Skill”界面

装好后重启 / 刷新宿主即可发现该 Skill。

### 典型用法

1. 由 Agent（或你）把已收集的发票整理成 Skill 约定的输入（员工信息 + 发票列表：原始文本 / 邮件主题 / 文件名 / 已解析字段）。
2. Skill 做字段整理、城市归一、重复检测，并按公司政策做**按日聚合的合规审核**。
3. 对超标项给出选择：**按标准报销** 或 **按实际报销（需填原因）**，以及调整 / 稍后处理。
4. 输出结构化结果：整理草稿、政策发现、待确认问题、审核决定模板与摘要，供后续生成报销文档。

### 分工

- **宿主 Agent** 负责：连接邮箱、下载附件、解析文件、OCR、凭据管理。
- **通用 Skill** 负责：公司政策、字段整理、合规审核与结构化输出。
- 生成**与公司官方模板一致、可递交的正式 Excel** 属公司内部受控能力（需官方模板与映射），**不在本公开仓库范围内**，由公司内部渠道提供。

### 如何获取通用 Skill

通用 Skill 的可运行包（含公司政策数据与受控模板适配器）通过**公司内部渠道**分发，不在本公开仓库发布。请向项目负责人或公司内部制品库获取。

---

## 常见问题

- **链接打不开 / 工具连不上**：多半是服务地址变更。回到本仓库根 `README.md` 查看最新地址后更新你的配置。
- **MCP 客户端看不到 `rebu` 工具**：确认 Node ≥ 18、`mcpServers` JSON 无语法错误，然后完整重启客户端。
- **Skill 未被宿主发现**：确认复制的是**完整 Skill 目录**并重启 / 刷新宿主。
- **凭据如何填**：一律走宿主安全输入或环境变量，绝不要写进聊天、截图或提交到 Git。

---

## 说明

- 本仓库仅提供**使用文档**；不含公司官方模板、内部政策原文、物理映射或后端代码。
- 文中服务地址可能随部署调整；本 `README.md` 为最新地址与用法的权威入口。
