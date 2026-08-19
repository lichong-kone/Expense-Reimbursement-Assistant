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

# 类别二 · 通用 Skill

平台中立、不依赖服务器、只需 Node 18+。Agent 装上后，用自身能力（读邮件、解析附件、OCR）配合本 Skill 的公司政策与审核逻辑，完成报销整理与结构化输出。

> **Skill**：一个带 YAML frontmatter（`name`、`description`）的 `SKILL.md` 加同目录资源。安装即把该目录放到宿主的 skills 位置（Kiro `~/.kiro/skills/`；部分宿主 `~/.agents/skills/`；或宿主导入界面）。

## 用法

**推荐：装上 Skill，直接跟你的 Agent 说需求。** 例如"帮我整理这些发票报销"或"从我邮箱收发票并生成报销单"。Agent 会参考 `SKILL.md` **逐项询问**数据源、收件/输出路径、员工基础信息并保存，邮箱模式会**先做网络预检**，再**替你调用**下面的固定脚本——你不用手敲命令，也**不用先自己跑 sh**。引导流程见 SKILL.md §9。

底层按"发票文本是否已由宿主提取好"分两条路径，Agent 会替你选；想自己手动跑时也可直接用：

| 路径 | 适用 | 依赖 |
| --- | --- | --- |
| **A · 零依赖核心** | 宿主已把发票解析成文本，只要政策整理与审核 | 仅 Node ≥ 18 |
| **B · 端到端自动收票（可选）** | 让脚本自己从本地文件夹或邮箱收票、解析、审核、出正式 Excel | Node ≥ 18 + `imapflow`/`pdf-parse`/`adm-zip`/`tesseract.js` |

<details>
<summary><b>手动 / CLI 用法 · 路径 A（零依赖核心）</b></summary>

```bash
git clone --depth 1 https://github.com/lichong-kone/Expense-Reimbursement-Assistant.git
cd Expense-Reimbursement-Assistant
bash reimburse.sh reimbursement.json
```

- 第 1 次：生成骨架 `reimbursement.json`，填入员工、行程、已提取的发票文本。
- 第 2 次：生成审核包 `reimbursement-output/`；如有超标项，在其中 `review-decisions.template.json` 填写每项 `action`（`keep`/`adjust`/`exempt`+原因/`provide_info`/`defer`）。
- 第 3 次：检测到决定已填，自动应用，产出 `reimbursement-reviewed/`（含实际/可报销总额、已应用决定）。

Node ≥ 18，零依赖，离线。输出含 `summary.md`、政策报告、审核问题、`template-input.json`、`host-contract.json`、审计与 SHA-256 manifest。增量：`reimburse.sh` 自动维护状态文件（`<name>-state.json`），重复运行只处理新发票。可选 `bash install.sh` 把 Skill 注册进宿主（自动探测 `~/.kiro/skills` 或 `~/.agents/skills`，或 `--dest` 指定）。
</details>

<details>
<summary><b>手动 / CLI 用法 · 路径 B（端到端自动收票，可选）</b></summary>

```bash
# 1) 引导式配置：选数据源 / 填路径 / 存员工基础信息（密码绝不入配置）
node scripts/local-collector/setup.mjs                 # 交互式
node scripts/local-collector/setup.mjs --mode mailbox --provider qq \
  --name 张三 --employee-id K12345 --level staff \
  --mailbox-user zhangsan@qq.com --password-env REBU_IMAP_PASS --print

# 2) 邮箱网络预检：公司网络常拦截出站 IMAP 993，先验证连通性
node scripts/local-collector/index.mjs --config ./sources.json --precheck

# 3) 运行完整管线：收票 → 提取 → 政策审核 → 可选正式 Excel
node scripts/local-collector/index.mjs --config ./sources.json --once
```

- 数据源 `local`（文件夹）/ `mailbox`（IMAP）/ `both`；员工信息存 `employee.json` 复用。
- 网络预检两阶段（TCP → IMAP，带超时），受限网络明确提示"可能被公司代理/SASE 拦截，请换网络或配代理"，不会卡住。
- 凭据只走环境变量（默认 `REBU_IMAP_PASS`）或宿主 Secret Store，绝不写入 `sources.json`/日志/对话。
</details>

详见 [采集器说明](scripts/local-collector/README.md)。

## 正式 Excel

`reimburse.sh` 在整理与审核完成后，从随包的公司官方模板直接生成**可递交的正式《费用报销单》Excel**（首次会自动安装渲染依赖 `adm-zip`）。正式 Excel 从官方模板副本写入，只改授权单元格，其余公式/样式/合并/勾选框/打印设置逐字节保留；模板 SHA-256 或映射版本不匹配、保真校验失败时拒绝交付。产物含 `bundle-summary.md`（是否可递交）与 `bundle-manifest.json`（版本与 hash）。

也可手动渲染：

```bash
node skills/kone-expense-reimbursement/template-adapter/install-or-verify.mjs   # 校验完整性
node skills/kone-expense-reimbursement/template-adapter/bundle.mjs \
  --template-input <name>-output/template-input.json --output-dir <name>-excel
```

详见 [通用 Skill 说明](skills/kone-expense-reimbursement/README.md)。

---

## 各类第三方 Agent 通用安装说明

- **支持 Skill 目录的宿主（Kiro、WorkBuddy）**：复制整个 Skill 目录到宿主 skills 目录后重启/刷新。
- **仅支持 MCP 的客户端（Claude Desktop、Cline、Continue）**：按类别一配置 `rebu` MCP；通用 Skill 的整理/审核在本机运行 `portable-core.mjs`，把 `SKILL.md` 作为系统提示注入。
- **自研 Agent**：读 `manifest.json` 发现能力与输入输出契约。

## 说明

- 本仓库提供使用文档、可安装 Skill 与一个公司官方报销 Excel 模板；不含内部政策原文 PDF 或后端代码。
- 文中服务地址可能随部署调整；本 `README.md` 为最新地址与用法的权威入口。
