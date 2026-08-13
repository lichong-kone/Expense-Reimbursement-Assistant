# Expense Reimbursement Assistant（报销助手）

面向使用者的**公开仓库**：使用文档 + 可安装的 Agent Skill。按“是否依赖现有服务器服务”分为**两类**。

> ⚠️ **域名可能变更**：下文服务地址（当前 `https://metagentictool.com`）可能调整。**访问不了就回到本仓库根 `README.md` 查看最新地址**——本文件随地址更新。
>
> 本仓库只含**使用文档与通用 Skill 的可安装文件**。公司官方报销模板、内部政策原文 PDF、物理单元格映射与后端服务代码属受控资产，**不在本仓库**，由公司内部渠道提供。

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

# 类别二 · 通用 Skill

平台中立、不依赖服务器、只需 Node 18+。Agent 装上后，用自身能力（读邮件、解析附件、OCR）配合本 Skill 的公司政策与审核逻辑，完成报销整理与结构化输出。

> **Skill**：一个带 YAML frontmatter（`name`、`description`）的 `SKILL.md` 加同目录资源。安装即把该目录放到宿主的 skills 位置（Kiro `~/.kiro/skills/`；部分宿主 `~/.agents/skills/`；或宿主导入界面）。

## 用法

克隆一次，然后反复运行同一条命令，脚本自动推进：

```bash
git clone --depth 1 https://github.com/lichong-kone/Expense-Reimbursement-Assistant.git
cd Expense-Reimbursement-Assistant

bash reimburse.sh reimbursement.json
```

- 第 1 次：生成骨架 `reimbursement.json`，填入员工、行程、已提取的发票文本。
- 第 2 次：生成审核包 `reimbursement-output/`；如有超标项，在其中 `review-decisions.template.json` 填写每项 `action`（`keep`/`adjust`/`exempt`+原因/`provide_info`/`defer`）。
- 第 3 次：检测到决定已填，自动应用，产出 `reimbursement-reviewed/`（含实际/可报销总额、已应用决定）。

Node ≥ 18，零依赖，离线。输出含 `summary.md`、政策报告、审核问题、`template-input.json`、`host-contract.json`、审计与 SHA-256 manifest。

> **增量**：`reimburse.sh` 自动维护一个状态文件（`<name>-state.json`），重复运行只处理新发票、跳过已处理的（按发票号+金额+日期去重）。连邮箱、只取新邮件的增量拉取由 Agent 环境负责；本状态文件保证“已处理不重复”。零依赖、离线。

> 可选：`bash install.sh` 把 Skill 注册进宿主（自动探测 `~/.kiro/skills` 或 `~/.agents/skills`，或 `--dest` 指定），让宿主自动发现编排。

## 正式 Excel

本公开包不生成公司官方模板的正式 Excel（官方模板与物理映射为公司内部受控资产，不在本仓库）。它输出 `template-input.json` / `host-contract.json`，供宿主或公司内部适配器生成正式《费用报销单》。

详见 [通用 Skill 说明](skills/kone-expense-reimbursement/README.md)。

---

## 各类第三方 Agent 通用安装说明

- **支持 Skill 目录的宿主（Kiro、WorkBuddy）**：复制整个 Skill 目录到宿主 skills 目录后重启/刷新。
- **仅支持 MCP 的客户端（Claude Desktop、Cline、Continue）**：按类别一配置 `rebu` MCP；通用 Skill 的整理/审核在本机运行 `portable-core.mjs`，把 `SKILL.md` 作为系统提示注入。
- **自研 Agent**：读 `manifest.json` 发现能力与输入输出契约。

## 说明

- 本仓库只提供使用文档与通用 Skill 可安装文件；不含官方模板、政策原文 PDF、物理映射或后端代码。
- 文中服务地址可能随部署调整；本 `README.md` 为最新地址与用法的权威入口。
