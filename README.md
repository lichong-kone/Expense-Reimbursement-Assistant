# Expense Reimbursement Assistant（报销助手）

帮你整理发票、按公司政策审核、生成可递交的《费用报销单》。有两种用法：

- **类别二 · 通用 Skill**：任意 Agent，装个 Skill 就能用，不连服务器。**多数人用这个。**
- **类别一 · 在线服务**：连 REBU 服务器，网页或支持 MCP 的 Agent，数据在线持久化。

> 服务地址当前 `https://metagentictool.com`，可能变更；打不开就回本 README 看最新地址。

---

# 类别二 · 通用 Skill（装上即用）

## 安装

把 `skills/kone-expense-reimbursement` 文件夹放进你 Agent 的 skills 目录，重启 / 刷新。**不用装 MCP、不用跑脚本，Windows / macOS / Linux 一样。**

- **拿文件**：本仓库 GitHub 页面 → **Code → Download ZIP** 解压（或 `git clone`）。
- **放哪里**：Kiro 放 `~/.kiro/skills/`（Windows：`%USERPROFILE%\.kiro\skills\`）；有“导入 / 添加 Skill”界面的宿主，直接选这个文件夹。

## 用法

1. 对 Agent 说需求，比如“帮我整理这个月的报销”“从我邮箱收发票，生成报销单”。
2. Agent 问你几件事——**姓名 / 工号 / 级别**、发票**在哪**（文件夹还是邮箱）。答完它就自动：收票 → 按政策审核 → 生成《费用报销单》。超标或缺信息，它会在对话里问你怎么办。
3. 基础信息**只填一次**，存本机；以后直接说“整理这次的报销”，自动只处理新发票。

> 选邮箱时，连不上会告诉你原因（公司网络常拦，换网络或按公司代理再试）。邮箱密码 / 授权码只在本机安全存放，不进文件、不进对话。

---

# 类别一 · 在线服务（Web / MCP）

连 REBU 服务器，在线全流程、数据持久化。两种入口：

## 入口 1 · 网页（免安装）

打开 `https://metagentictool.com` → 注册登录 → 绑定邮箱（填 IMAP 授权码）→ 同步发票 → 确认存疑 / 缺字段项 → 建单、导出公司格式报销文件。

## 入口 2 · 支持 MCP 的 Agent

需要装两样：

**① 装 Skill**：把 `skills/rebu-expense-agent` 文件夹放进你 Agent 的 skills 目录（放法同类别二），重启。

**② 装 MCP**：把下面加到你客户端的 MCP 配置里，保存后重启：

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

- **Claude Desktop**：macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows `%APPDATA%\Claude\claude_desktop_config.json`
- **Cline / Continue**：在扩展的 MCP 设置里添加。

装好后对 Agent 说：“连接报销服务，先看配置和待办，再同步最近发票。”

---

- 本仓库含使用文档、可安装 Skill、一个公司官方报销 Excel 模板；不含政策原文 PDF 与后端代码。
- 密码 / 授权码只在网页或宿主安全输入，别写进聊天、截图或公开渠道。
