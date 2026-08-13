---
name: kone-expense-reimbursement
description: >
  Turn a KONE/通力 employee's invoices (from email/PDF/OFD/XML) into a compliant
  《费用报销单》Excel. Use when the user asks to 整理报销 / 生成报销单 / 报销发票 /
  fill the reimbursement template, or connects a mailbox to collect fapiao. Encodes
  the company reimbursement policy (per-level meal/hotel limits, supporting-doc
  requirements, timing, header rules) + the Excel output mapping. The host agent
  (e.g. WorkBuddy/MCP) supplies the generic plumbing: IMAP connect, PDF/OFD/XML
  parsing, scheduling. This skill supplies the domain knowledge only.
  This public package provides policy, organization, review, and structured
  outputs; generating the company's official-template Excel is a company-internal
  capability provided separately.
---

# 通力（KONE）费用报销 Skill

## 何时使用
- 用户要"整理报销 / 生成报销单 / 报销这些发票 / 填报销申请表"。
- 用户连接了邮箱、要从邮件里收集电子发票并成单。

## 前提（由宿主 agent 提供的通用能力）
- 邮箱 IMAP 连接与增量拉取（游标：优先 UID 高水位，其次时间窗）。
- 文档解析：PDF 文本层、OFD（GB/T 33190，zip+XML）、全电发票 XML（SWEI/EInvoice）、OCR 兜底。
- 定时任务（每 12 小时 / 每天）。
- 生成/写入 Excel。

## 一、提取字段（目标最小集）
每张发票需要：`发票号码, 发票类型, 开票日期, 消费日期(trip_date), 金额(含税), 税额, 销售方(抬头), 费用类别, 城市, 出发地, 目的地, 交通方式`。

提取优先级（命中即停，逐层只补缺字段）：
1. **结构化直读（最优先，无需 OCR）**：
   - 全电 **XML**：按标签取 `InvoiceNumber/EIid`、`TotalTax-includedAmount`(价税合计)、`TotalTaxAm`、`TotalAmWithoutTax`、`IssueTime`、`SellerName`。
   - **OFD**：解压读 `Doc_0/Attachs/*.xml` 结构化附件（优先），否则读 Content.xml 文本。
2. **邮件正文/主题/发件人/附件名**（正则+关键词）。
3. **PDF 文本层**（数字发票直读）。
4. **OCR**（扫描件/图片兜底）。

## 二、同邮件附件归并（关键规则）
一封邮件里通常是「一张发票 + 若干附件」。规则：
- 按邮件唯一键（account + email uid）分组；
- 组内选**主发票**（非支持件、有发票号、金额最大）；
- **其余 PDF 全部挂为它的支持件**（不计入金额合计），尤其：打车发票+行程单、酒店发票+水单；
- 例外：若一封邮件里确有多张独立真发票（各自有不同发票号且金额独立），则各自独立，不强行折叠。

## 三、去重（增量安全）
三级唯一键，任一命中即视为重复、跳过入库：
1. 邮件级 `message_id / email_uid`
2. 附件级 `file_hash`
3. 业务级 `invoice_number + seller + amount + invoice_date`

## 四、公司政策与标准（提示，不强阻断）
> 原则：报销必须真实、必要、与业务相关；不得拆分大额规避；多人活动由职位最高者报销；不代办。以上仅作背景，不做系统约束。

### 4.1 时效（仅提示）
- 业务发生后 **1 个月内**申报；票据超 **90 天**公司可拒；**每月 20 日前**交共享服务中心；**12 月 31 日**前结清。

### 4.2 抬头
- 原则开给 **通力电梯有限公司**；公路/铁路等**实名交通票**可开个人（白名单例外）。缺开票日期/抬头/金额/票种 → 进"待补件"。

### 4.3 餐费（其他差旅费）
- 国内大陆：**Staff ¥100/天，Manager ¥200/天，Assistant Director / Director 实报实销**。
- 中国境外及港澳台：**实报实销**。
- 总额度 ≈ **出差日历天数 × 个人日限额**。
- 若一人统一支付：必须列出**参与人姓名、部门、适用标准**；否则超标部分个人承担。

### 4.4 住宿
- **城市等级 × 员工等级**矩阵限额（具体数值以公司标准表为准）；境外/港澳台**实报实销**。
- 单晚 **> ¥300** 必须附**酒店水单**。
- 城市等级：一类＝上海/广州/北京/深圳；二类＝省会/直辖市/浙苏粤分公司所在城市/厦门/三亚/大连/青岛；三类＝其余。

### 4.5 交通
- 同行程优先更经济合理方式。火车：其他员工**二等座**，(Assistant) Director 及以上**一等座**。
- 出租车/网约车须记录**日期、起止地、业务用途**；缺路线信息 → 提示补充后可继续。
- 差旅期间市内交通逐条列入报销单；非差旅市内交通需《交通费用明细表》。

### 4.6 其它
- 会议/培训已含食宿交通的项目**不重复报销**。
- 因个人原因延住/超标：超出部分**个人承担，不写入公司报销金额**。

### 4.7 处理口径
- 以上超标/超期/缺件**只提示、可修改后继续**，不强阻断。缺必需字段或低置信 → 标"待确认"，交用户补充/确认。

## 五、输出：《费用报销单》Excel
严格保留公司模板格式，只在指定可编辑区域填写；固定区域/公式/样式**只读不动**。

### 5.1 个人信息（默认加载上次值，可改）
`姓名、工号、部门、职位、成本中心号`。

### 5.2 报销内容表（一票一行）
- 左侧（用户可编辑）：`日期、城市、开支用途、发票币种、汇率`（国内默认不改）；`发票原币金额、人民币金额`按右侧金额自动更新。
- 右侧登记金额，在 **Business Travel 差旅费**下：
  - **住宿**（hotel/accommodation）
  - **车船票/出租**（交通类：train/taxi/flight 等）
  - **其他差旅费**（餐饮 meal；每次出差有额度，常见上限每天 ¥100，超额需与用户确认/说明）
- **每张发票对应一行**；超过模板可写行数时**自动拆分为多个文件**，顶部个人信息（抬头）继承第一个文件。

### 5.3 《出差申请表》
- 当前**先跳过**（如需：带入姓名/部门/职位、成本中心、行程、是否住宿、交通方式；出差原因可默认或手填）。

### 5.4 导出交付物
`费用报销单.xlsx` + 原始发票与支持件归档 + 标准提示摘要 + 修改日志摘要。

## 六、人机协作
- 自动优先、人工兜底：系统预填，用户只确认/修改少量"待确认"项。
- 所有自动识别字段保留**来源与置信度**；人工修改保留痕迹（before/after/operator/time/reason）。

## 资源（随 skill 附带）
- 政策规则快照：`resources/policy-rules.json`（版本化，供本地政策检查使用）。
- 说明：公司官方 Excel 模板、政策原文 PDF 与物理字段映射属公司内部受控资产，**不随本公开包分发**；正式《费用报销单》Excel 由公司内部适配器渲染。本 Skill 输出 `template-input.json` / `host-contract.json` 等结构化结果，供宿主或内部适配器生成最终文档。

---

## 七、可携带执行模式（Portable Mode, Spec §6.8.2）

本 Skill 同时支持**可携带模式**运行，无需 REBU 服务器、数据库、IMAP、SMTP 或任何网络连接。

### 7.1 运行前提
- Node.js >= 18
- 零外部 npm 依赖
- 所有政策规则内嵌于 `resources/policy-rules.json`
- **边界**：portable core 只接收 `PortableSkillInput` JSON 中的已提取文本/结构化字段；PDF/OFD/XML 解析与受控 Excel 模板写入由获授权宿主 adapter 完成，不由本地 core 承诺。

### 7.2 入口
```bash
# 1) 创建可编辑的 JSON 骨架
node portable-core.mjs --init ./my-reimbursement.json

# 2) 编辑后先验证（不会写业务产物）
node portable-core.mjs --validate --input ./my-reimbursement.json

# 3) 生成离线审核包
node portable-core.mjs --input ./my-reimbursement.json --output-dir ./output

# 4) 填写 output/review-decisions.template.json 后显式提交决定
node portable-core.mjs --input ./my-reimbursement.json \
  --decisions ./output/review-decisions.template.json \
  --output-dir ./output-reviewed
```

### 7.3 输入格式（PortableSkillInput）
```json
{
  "employee": { "name": "...", "level": "staff", ... },
  "trip": { "startDate": "...", "endDate": "..." },
  "invoices": [
    { "id": "1", "rawText": "...", "emailSubject": "...", "fileName": "..." }
  ]
}
```

### 7.4 核心能力
| 能力 | 说明 |
|------|------|
| 发票必填字段判定 | 按 invoice type 判定 required set，输出 `parsed` / `need_confirm` |
| 基础文本提取 | 从 rawText / emailSubject / fileName / emailBody 提取金额、日期、发票号、销售方、城市、路线 |
| 一级城市归一 | 子区域/站点→一级城市（如 浦东→上海、昆山→苏州） |
| 政策检查 | 基于 versioned JSON 规则做 meal/hotel 限额 + rail 座席检查 |
| 输出产物 | `summary.md`（已处理/待决定/下一步/恢复路径）、`reimbursement-draft.json`、`policy-report.json`、`policy-findings.json`、`review-questions.{json,md}`、`review-decisions.template.json`、`decision-log.json`（仅显式提交决定时）、`template-input.json`、`audit.ndjson`、`manifest.json` |
| 审核决定 | `exempt` 必填原因；`adjust` / `provide_info` 必填白名单字段补丁并重跑校验；`keep` 保留原值；`defer` 记录稍后处理。缺失/无效决定绝不自动解除确认门 |

### 7.5 规则版本溯源
- 规则数据来源：`migration_014`（基础表）+ `migration_023`（酒店限额 + EVP 等级）
- 每条规则携带 `ruleId`、`source`、`version` 字段
- 快照版本：`resources/policy-rules.json` → `version: "2.0.0"`

### 7.6 与服务模式的关系
- **服务模式**（`skills/rebu-expense-agent`）：完整 REBU 后端，含 DB、IMAP、OCR、模板填充
- **可携带模式**（本目录）：纯逻辑 + 规则快照，可独立部署或嵌入 WorkBuddy/MCP 等宿主
- `template-input.json` 输出结构兼容服务模式的模板填充入参

### 7.7 WorkBuddy 集成
- `config.yaml`：触发意图、执行参数、权限声明
- `manifest.json`：标准 manifest，含 capabilities / inputs / outputs schema
- 宿主通过 manifest 发现能力，通过 config.yaml 绑定触发器

### 7.8 Phase 13.2: 平台中立标准包 (§6.8.4)

v1.2.0 新增：

1. **按日聚合**：`meal` 和 `hotel` 按 `(tripDate || invoiceDate, category)` 聚合为组，每组输出 `actualAmount`、`standardAmount`、`exceedAmount`、`invoiceIds`、`reimbursableAmount`。交通和其他类保持逐票行。缺日期的项目产生独立补充信息问题，不跨日静默合并。

2. **结算选项**：超标组暴露 `cap_to_standard` / `claim_actual_with_reason`，映射到既有 action：
   - `keep` → 封顶到标准
   - `exempt` + reason → 按实际报销
   - `adjust` → 重算
   - `defer` → 保守封顶（待决定）

3. **host-contract.json**：版本化逻辑合同，定义 header 字段、聚合/逐票 detail 行类型和语义。**不含模板文件、sheet 名、单元格坐标、公式或 OOXML**。宿主 adapter 负责映射到其授权模板。

4. **template-input.json**：新增 `contractVersion` 字段。行按 `rowType` 区分 `aggregated`（受限类一日一行）和 `per_ticket`（交通逐票）。每行含 `actualAmount`、`reimbursableAmount`、`settlement`、`reason`。

5. **manifest.json**：新增 `skillVersion`、`hostContractVersion`；`outputHashes` 包含 host-contract.json。

6. **无破坏性变更**：`keep/exempt/adjust/provide_info/defer` 行为不变。既有 decisions 文件可继续读取。
