# Expense Reimbursement Assistant（报销助手）

帮你整理发票、按公司政策审核、生成可递交的《费用报销单》。两种用法：

- **类别一 · 在线服务**：连 REBU 服务器，网页或支持 MCP 的 Agent，数据在线持久化。
- **类别二 · 通用 Skill**：任意 Agent，装个 Skill 就能用，不连服务器。

> 开始前：电脑终端能跑 `git` 和 `node`（Node 18+）；没有就先装 [Git](https://git-scm.com/downloads)、[Node.js](https://nodejs.org)。
> 服务地址当前 `https://metagentictool.com`；打不开就回本 README 看最新地址。

---

# 类别一 · 在线服务（Web / MCP）

连 REBU 服务器，在线全流程、数据持久化。两种入口：

## 入口 1 · 网页（免安装）

打开 `https://metagentictool.com` → 注册登录 → 绑定邮箱（填 IMAP 授权码）→ 同步发票 → 确认存疑 / 缺字段项 → 建单、导出公司格式报销文件。

## 入口 2 · 支持 MCP 的 Agent

**① 装 Skill：**

```bash
git clone https://github.com/lichong-kone/Expense-Reimbursement-Assistant.git
cd Expense-Reimbursement-Assistant
node install.mjs --skill service --host <你的 Agent>   # copilot | kiro | claude | agents
```

`--host` 指定你**实际使用的 Agent**的 skills 目录（Copilot CLI → `~/.copilot/skills`；Kiro → `~/.kiro/skills`；Claude → `~/.claude/skills`；通用 → `~/.agents/skills`），或用 `--dest <目录>` 自定义。装好后重启 Agent（Copilot CLI 可在会话里 `/skills reload`）。**Windows / macOS / Linux 同一条命令**（Node，不是 bash）。

**② 配 MCP：** 打开你 Agent 的配置文件（位置见下），把下面这段粘贴进去，保存后重启：

```json
{
  "mcpServers": {
    "rebu": {
      "command": "npx",
      "args": ["-y", "https://metagentictool.com/downloads/rebu-mcp-1.1.4.tgz"],
      "env": { "REBU_API_BASE": "https://metagentictool.com" }
    }
  }
}
```

- **Claude Desktop**：macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Windows `%APPDATA%\Claude\claude_desktop_config.json`
- **Cline / Continue**：在扩展的 MCP 设置里添加。

装好后对 Agent 说：“连接报销服务，先看配置和待办，再同步最近发票。”

---

# 类别二 · 通用 Skill（装上即用）

## 安装

```bash
git clone https://github.com/lichong-kone/Expense-Reimbursement-Assistant.git
cd Expense-Reimbursement-Assistant
node install.mjs --host <你的 Agent>    # copilot | kiro | claude | agents
```

`--host` 指定你**实际使用的 Agent**的 skills 目录（Copilot CLI → `~/.copilot/skills`；Kiro → `~/.kiro/skills`；Claude → `~/.claude/skills`；通用 → `~/.agents/skills`），或 `--dest <目录>` 自定义。装完重启/刷新 Agent（Copilot CLI 在会话里 `/skills reload`，再 `/skills info kone-expense-reimbursement` 确认）。**Windows / macOS / Linux 同一条命令**（Node，不是 bash）。**不用配 MCP。**

## 用法

1. 对 Agent 说需求，比如“帮我整理这个月的报销”“从我邮箱收发票，生成报销单”。
2. Agent 问你几件事——**姓名 / 工号 / 级别**、发票**在哪**（文件夹还是邮箱）。答完它就自动：收票 → 按政策审核 → 生成《费用报销单》。超标或缺信息，它会在对话里问你怎么办。
3. 基础信息**只填一次**，存本机；以后直接说“整理这次的报销”，自动只处理新发票。

> 选邮箱时 Agent 会先测连通性。公司电脑常被安全策略（Prisma Access/SASE）拦掉外部邮箱端口，**换网络（含手机热点）多半也绕不过**——这时直接用『本地文件夹』方式（把发票放进一个文件夹）最省事，或用个人设备。邮箱密码 / 授权码只在本机安全存放，不进文件、不进对话。

---

> 密码 / 授权码只在网页或宿主安全输入，别写进聊天、截图或公开渠道。
