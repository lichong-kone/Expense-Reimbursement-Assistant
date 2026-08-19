# Expense Reimbursement Assistant（报销助手）

面向使用者的**公开仓库**：使用文档 + 可安装的 Agent Skill。按“是否依赖现有服务器服务”分为**两类**。

> ⚠️ **域名可能变更**：下文服务地址（当前 `https://metagentictool.com`）可能调整。**访问不了就回到本仓库根 `README.md` 查看最新地址**——本文件随地址更新。
>
> 本仓库含**使用文档、可安装的 Agent Skill，以及一个公司官方报销 Excel 模板**（用于生成可递交的正式《费用报销单》）。内部政策原文 PDF、后端服务代码不在本仓库。

## 两类怎么选

| 你的情况 | 选择 | 依赖 |
| --- | --- | --- |
| 想要在线全流程（网页或支持 MCP 的 Agent，收票→审核→建单→正式 Excel，数据持久化） | **类别一 · 基于现有服务（Web + 服务型 Skill/MCP）** | 需要现有服务器服务 |
| 用任意 Agent，平台中立地整理与审核报销资料、产出结构化结果 | **类别二 · 通用 Skill** | 只需 Node 18+ |

---

# 类别一 · 基于现有服务（Web + 服务型 Skill / MCP）

连接现有服务器服务，支持两种入口:**网页**和**服务型 Skill（MCP）**。

## 1. 网页（Web）

1. 浏览器打开服务地址（当前 `https://metagentictool.com`）。
2. 注册 / 登录。
3. 绑定邮箱（IMAP，填授权码）。
4. 同步发票（手动“立即同步”或按频率自动增量）。
5. 整理与确认存疑/缺字段/疑似重复项。
6. 查看政策提示（超标/超期/缺件，仅提示）。
7. 建单、分配发票、导出公司格式报销文件。

> 账号密码、邮箱授权码只在网页安全输入，不要写入聊天、截图或公开渠道。

## 2. 服务型 Skill + MCP

适合支持 [MCP](https://modelcontextprotocol.io) 的 Agent（Claude Desktop、Cline、Continue、WorkBuddy、自研）。

**2.1 配置 MCP 客户端**（`mcpServers`，固定版本 URL）：

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

常见配置入口：Claude Desktop（macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows `%APPDATA%\Claude\claude_desktop_config.json`）、Cline/Continue 扩展的 MCP 设置、WorkBuddy/自研宿主的 stdio MCP 设置。保存后重启客户端，应看到 `rebu` 服务和 `rebu_*` 工具。

> 下载地址或 `REBU_API_BASE` 打不开 = 服务地址已变更，回本 README 查最新地址。

**2.2 安装服务型 Skill**（本仓库已含文件）：

```bash
git clone --depth 1 https://github.com/lichong-kone/Expense-Reimbursement-Assistant.git
bash Expense-Reimbursement-Assistant/install.sh --skill service
# 或手动复制： cp -R Expense-Reimbursement-Assistant/skills/rebu-expense-agent <你的宿主 skills 目录>/
```

**2.3 使用**：连接后说“连接报销服务：先检查配置和待办，再同步最近发票”。流程在批量处理前说明范围与撤销方式，按“已自动处理 / 仍需决定 / 下一步”交付；审核动作统一为 `keep` / `adjust` / `exempt` / `provide_info` / `defer`。凭据一律走宿主 Secret Store / 安全输入 / 环境变量。

详见 [服务型 Skill 说明](skills/rebu-expense-agent/README.md)。

---

# 类别二 · 通用 Skill（任意 Agent，装上即用）

不依赖服务器。把它装进你的 Agent，然后用**大白话**让它帮你报销——需要什么信息，Agent 在对话里问你；第一次问一遍，以后自动。

## 怎么用

**第 1 步 · 安装**：用你 Agent 的“导入 / 添加 Skill”功能装上，或把 Skill 文件夹放进宿主的 skills 目录，然后重启 / 刷新。**Windows、macOS、Linux 都一样**——不用装命令行工具、不用跑脚本。

**第 2 步 · 说需求**：直接对 Agent 说，比如——
- “帮我整理这个月的报销。”
- “从我邮箱收发票，生成报销单。”
- “这个文件夹里是我的发票，帮我报销。”

**第 3 步 · 回答几个问题**：Agent 会问你几件事——你的**姓名 / 工号 / 级别**、发票**在哪**（本地文件夹，还是邮箱）。答完它就自动干活：收票 → 按公司政策审核 → 生成可递交的《费用报销单》。遇到**超标或缺信息**，它会在对话里问你怎么办（按标准报，还是按实际报并说明原因），你选一下就行。

你**不用装依赖、不用记命令、不用自己跑脚本**——这些 Agent 替你完成；“从本地还是从邮箱、怎么取”也由它根据你的回答判断，你不用操心。

### 以后更省事

姓名/工号/级别这些**只填一次**，存在你本机。以后直接说“整理这次的报销”，Agent 自动读取、只处理**新发票**、直接出结果，不再重复问。

### 关于邮箱

选“从邮箱收”时，Agent 会**先确认能不能连上你的邮箱**（公司网络有时会拦）。连不上会直接告诉你原因、教你怎么办（比如换个网络，或按公司代理设置再试），不会卡住。你的**邮箱密码/授权码只在本机安全存放**，不会写进文件，也不会出现在对话里。

---

## 在不同 Agent 里怎么装

<details>
<summary>各类宿主的安装方式（技术说明）</summary>

- **支持 Skill 目录的宿主（Kiro、WorkBuddy）**：把整个 Skill 目录复制到宿主 skills 目录后重启/刷新。
- **仅支持 MCP 的客户端（Claude Desktop、Cline、Continue）**：按类别一配置 `rebu` MCP；通用 Skill 的整理/审核在本机运行，把 `SKILL.md` 作为系统提示注入。
- **自研 Agent**：读 `manifest.json` 发现能力与输入输出契约。
</details>

## 说明

- 本仓库提供使用文档、可安装 Skill 与一个公司官方报销 Excel 模板；不含内部政策原文 PDF 或后端代码。
- 文中服务地址可能随部署调整；本 `README.md` 为最新地址与用法的权威入口。
