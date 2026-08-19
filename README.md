# Expense Reimbursement Assistant（报销助手）

面向使用者的**公开仓库**：使用文档 + 可安装的 Agent Skill。按“是否依赖现有服务器服务”分为**两类**。

> ⚠️ **域名可能变更**：下文服务地址（当前 `https://metagentictool.com`）可能调整。**访问不了就回到本仓库根 `README.md` 查看最新地址**——本文件随地址更新。
>
> 本仓库含**使用文档、可安装的 Agent Skill，以及一个公司官方报销 Excel 模板**（用于生成可递交的正式《费用报销单》）。内部政策原文 PDF、后端服务代码不在本仓库。

## 两类怎么选

| 你的情况 | 选择 | 依赖 |
| --- | --- | --- |
| 想要在线全流程（网页或支持 MCP 的 Agent，收票→审核→建单→正式 Excel，数据持久化） | **类别一 · 基于现有服务（Web + 服务型 Skill/MCP）** | 需要现有服务器服务 |
| 用任意 Agent，平台中立地整理与审核报销资料、产出结构化结果 | **类别二 · 通用 Skill** | 装上即用 |

---

# 先搞清楚两个“安装”

本仓库会用到两样东西，**它们是两回事**：

- **Skill（技能）** = 一个**文件夹**，放进你 Agent 的 skills 目录后，Agent 就懂了公司报销政策与流程。**两个类别都要装 Skill。**
- **MCP（工具服务）** = 让 Agent 连上 REBU **在线服务器**的桥。**只有类别一的“在线全流程”用得到；类别二完全不需要 MCP。**

下面把这两种安装分别讲清楚，两个类别都会引用。

## A. 怎么装 Skill（Windows / macOS / Linux 都一样，不用跑脚本）

**第 1 步 · 拿到文件**：在本仓库 GitHub 页面点 **Code → Download ZIP** 解压；或（装了 Git）`git clone https://github.com/lichong-kone/Expense-Reimbursement-Assistant.git`。

**第 2 步 · 放进你的 Agent**：把对应的 Skill 文件夹**复制**到宿主的 skills 目录，然后**重启 / 刷新**宿主。常见位置：

| 宿主 | skills 目录（macOS/Linux） | skills 目录（Windows） |
| --- | --- | --- |
| Kiro | `~/.kiro/skills/` | `%USERPROFILE%\.kiro\skills\` |
| 部分宿主（通用约定） | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |
| 有“导入 / 添加 Skill”界面的宿主 | 直接在界面里选中该 Skill 文件夹即可 | 同左 |

**装哪个 Skill？**
- 类别一（服务型）：装 `skills/rebu-expense-agent`
- 类别二（通用）：装 `skills/kone-expense-reimbursement`

> 复制文件夹在任何系统都一样：Windows 用资源管理器拖放，macOS 用 Finder，Linux 用文件管理器。**不需要命令行、不需要跑 `.sh`。**

## B. 怎么装 MCP（只有类别一“在线”需要）

把下面这段加到你 MCP 客户端的 `mcpServers` 配置里（固定版本 URL）：

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
- **Claude Desktop**：macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows `%APPDATA%\Claude\claude_desktop_config.json`
- **Cline / Continue**：在扩展的 MCP 设置里添加
- **WorkBuddy / 自研宿主**：添加一个 stdio MCP Server，填入上面的 `command`/`args`/`env`

保存后**重启客户端**，应能看到 `rebu` 服务和 `rebu_*` 工具。

> - 有些宿主能**从 Skill 清单自动接线 MCP**：那样装完 `rebu-expense-agent` 就能用，不必手动配这段。
> - **不想碰 MCP？** 用类别一的**网页**（免安装），或直接用**类别二**（根本不需要 MCP）。
> - 下载地址或 `REBU_API_BASE` 打不开 = 服务地址已变更，回本 README 查最新地址。
> - 账号密码、邮箱授权码只在网页 / 宿主安全输入，不要写入聊天、截图或公开渠道。

---

# 类别一 · 基于现有服务（Web + 服务型 Skill / MCP）

连接现有 REBU 服务器，支持两种入口：**网页**（最简单、免安装）和**服务型 Skill（MCP）**。

## 1. 网页（Web） — 免安装

1. 浏览器打开服务地址（当前 `https://metagentictool.com`）。
2. 注册 / 登录。
3. 绑定邮箱（IMAP，填授权码）。
4. 同步发票（手动“立即同步”或按频率自动增量）。
5. 整理与确认存疑 / 缺字段 / 疑似重复项。
6. 查看政策提示（超标 / 超期 / 缺件，仅提示）。
7. 建单、分配发票、导出公司格式报销文件。

## 2. 服务型 Skill + MCP — 给支持 MCP 的 Agent

适合支持 [MCP](https://modelcontextprotocol.io) 的 Agent（Claude Desktop、Cline、Continue、WorkBuddy、自研）。**需要装两样**：

1. **装 Skill**：按上面 [A. 怎么装 Skill](#a-怎么装-skillwindows--macos--linux-都一样不用跑脚本)，装 `skills/rebu-expense-agent`。
2. **装 MCP**：按上面 [B. 怎么装 MCP](#b-怎么装-mcp只有类别一在线需要)，加上 `rebu` 服务。

装好后，对 Agent 说：“连接报销服务：先检查配置和待办，再同步最近发票。” 流程会在批量处理前说明范围与撤销方式，按“已自动处理 / 仍需决定 / 下一步”交付；审核动作统一为 `keep` / `adjust` / `exempt` / `provide_info` / `defer`。凭据一律走宿主 Secret Store / 安全输入 / 环境变量。

详见 [服务型 Skill 说明](skills/rebu-expense-agent/README.md)。

---

# 类别二 · 通用 Skill（任意 Agent，装上即用）

不依赖服务器，**不需要 MCP**。把它装进你的 Agent，然后用**大白话**让它帮你报销——需要什么信息，Agent 在对话里问你；第一次问一遍，以后自动。

## 第 1 步 · 装 Skill

按上面 [A. 怎么装 Skill](#a-怎么装-skillwindows--macos--linux-都一样不用跑脚本)，装 `skills/kone-expense-reimbursement`（复制文件夹到宿主 skills 目录，或用宿主“导入 Skill”界面，然后重启 / 刷新）。**不需要装 MCP，不需要跑脚本。**

## 第 2 步 · 说需求

直接对 Agent 说，比如——
- “帮我整理这个月的报销。”
- “从我邮箱收发票，生成报销单。”
- “这个文件夹里是我的发票，帮我报销。”

## 第 3 步 · 回答几个问题

Agent 会问你几件事——你的**姓名 / 工号 / 级别**、发票**在哪**（本地文件夹，还是邮箱）。答完它就自动干活：收票 → 按公司政策审核 → 生成可递交的《费用报销单》。遇到**超标或缺信息**，它会在对话里问你怎么办（按标准报，还是按实际报并说明原因），你选一下就行。

你**不用装依赖、不用记命令、不用自己跑脚本**——这些 Agent 替你完成；“从本地还是从邮箱、怎么取”也由它根据你的回答判断。

### 以后更省事

姓名 / 工号 / 级别这些**只填一次**，存在你本机。以后直接说“整理这次的报销”，Agent 自动读取、只处理**新发票**、直接出结果，不再重复问。

### 关于邮箱

选“从邮箱收”时，Agent 会**先确认能不能连上你的邮箱**（公司网络有时会拦）。连不上会直接告诉你原因、教你怎么办（比如换个网络，或按公司代理设置再试），不会卡住。你的**邮箱密码 / 授权码只在本机安全存放**，不会写进文件，也不会出现在对话里。

详见 [通用 Skill 说明](skills/kone-expense-reimbursement/README.md)。

---

## 说明

- 本仓库提供使用文档、可安装 Skill 与一个公司官方报销 Excel 模板；不含内部政策原文 PDF 或后端代码。
- 文中服务地址可能随部署调整；本 `README.md` 为最新地址与用法的权威入口。
