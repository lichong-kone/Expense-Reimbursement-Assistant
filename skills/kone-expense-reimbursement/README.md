# kone-expense-reimbursement（通用 Skill）

**KONE/通力 费用报销通用 Skill** — 平台中立、自包含、零外部依赖的 Node.js 模块。

任何支持 Skill 的 Agent 装上后，用 Agent 自身能力（读邮件、下载附件、解析 PDF/OFD/XML、OCR）配合本 Skill 的**公司政策 + 字段整理 + 合规审核**逻辑，即可完成报销信息整理与结构化结果输出。

> **公开包边界**：本包提供政策、整理、审核与结构化输出（`template-input.json` / `host-contract.json`）。
> 本包随附一个公司官方报销 Excel 模板与渲染适配器：审核完成后可**直接生成与官方模板一致、可递交的正式《费用报销单》Excel**（首次自动安装渲染依赖 `adm-zip`）。内部政策原文 PDF 与后端代码不在本包。

## 运行前提

- Node.js **>= 18**
- **零外部 npm 依赖**（仅用 Node 内置模块）
- 无需网络、数据库、IMAP、SMTP

## 安装

安装就是把整个目录放到你的 Agent 宿主的 skills 目录（Kiro：`~/.kiro/skills/`；部分宿主：`~/.agents/skills/`；或用宿主自带的“导入 Skill”界面）。

```bash
cp -R kone-expense-reimbursement <你的宿主 skills 目录>/
```

> 必须整体复制目录，尤其 `resources/`（政策规则，运行时用 `__dirname` 解析）；不要单独移动 `portable-core.mjs`。

目录结构：

```
kone-expense-reimbursement/
├── portable-core.mjs         ← 入口（政策/整理/审核核心）
├── resources/
│   └── policy-rules.json      ← 运行时必需（版本化政策规则快照）
├── examples/
│   └── sample-input.json
├── scripts/
│   └── run.sh
├── config.yaml
├── manifest.json
├── SKILL.md
└── README.md
```

## 快速开始

```bash
cd <你的宿主 skills 目录>/kone-expense-reimbursement

# 1. 生成无凭据的可编辑输入骨架
node portable-core.mjs --init ./my-reimbursement.json

# 2. 填入员工/行程/已提取发票文本后校验（不写业务产物）
node portable-core.mjs --validate --input ./my-reimbursement.json

# 3. 生成离线审核包
node portable-core.mjs --input ./my-reimbursement.json --output-dir ./output

# 4. 填写 output/review-decisions.template.json 后显式提交决定
node portable-core.mjs \
  --input ./my-reimbursement.json \
  --decisions ./output/review-decisions.template.json \
  --output-dir ./output-reviewed
```

## 输出产物（写入 output/）

- `summary.md` — 实际/可报销总额、政策风险、待办、下一步
- `reimbursement-draft.json` — 提取字段、状态、按日聚合、总额
- `policy-report.json` / `policy-findings.json` — 政策检查结果与需确认项
- `review-questions.{json,md}` — 审核问题（含结算选项与金额影响）
- `review-decisions.template.json` — 可填写的审核决定模板
- `decision-log.json` — 已应用决定（仅提供 `--decisions` 时）
- `template-input.json` — 供宿主渲染文档的结构化数据（含 `contractVersion`）
- `host-contract.json` — 版本化逻辑模板契约（表头/明细行类型/字段语义；**不含物理模板、单元格坐标或 OOXML**）
- `audit.ndjson` / `manifest.json` — 本地审计与 SHA-256 清单

## 政策与审核

- 受限类别（餐费/住宿）按 `(行程日, 类别)` 聚合。
- 超标可选 `cap_to_standard`（按标准封顶）或 `claim_actual_with_reason`（按实际，必填原因）。
- 审核动作：`keep`（保留）/ `adjust`（调整，需字段补丁）/ `exempt`（豁免，必填原因）/ `provide_info`（补充信息）/ `defer`（稍后处理）。
- 缺失或无效决定绝不自动解除确认门。

## 分工

- **宿主 Agent** 负责：邮箱连接、附件下载、PDF/OFD/XML 解析、OCR、凭据管理。
- **本 Skill** 负责：公司政策、字段整理、合规审核、结构化输出。
- **正式官方 Excel** 由随包的 `template-adapter/` 从官方模板保真渲染（只改授权单元格，其余逐字节保留；校验失败拒绝交付）。

## 编程调用

```javascript
import { processInput, extractFields, normalizePrimaryCity, checkPolicy } from './portable-core.mjs';

const result = await processInput(inputData);
// result.draft / result.report / result.templateInput / result.reviewQuestions / ...
```

## License

UNLICENSED — Internal KONE use.
