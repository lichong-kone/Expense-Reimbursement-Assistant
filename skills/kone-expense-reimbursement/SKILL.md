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
- 官方模板：`template-adapter/official-template/报销申请_template.xlsx`（随包）。正式《费用报销单》Excel 由 `template-adapter/bundle.mjs` 从该官方模板保真渲染（首次需 `adm-zip`）。政策原文 PDF 与后端代码不随本包。本 Skill 也输出 `template-input.json` / `host-contract.json` 供宿主自定义渲染。

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

## 八、本地数据源模式（Local Datasource Mode, Spec §6.8.6）

除直接调用 portable-core.mjs 外，本 Skill 支持**本地数据源模式**——定期从数据源采集发票、整理、在本地文件夹生成正式报销文件，无需 Web 服务器。

### 8.1 核心模型

```
[填充器: local / mailbox] ──→ inboxDir/ ──→ [宿主提取] ──→ [portable-core] ──→ [template-adapter] ──→ outputDir/
```

- **inboxDir**：统一收件文件夹。所有数据源填充器把发票文件放入此目录。
- **outputDir**：审核包与正式 Excel 输出。

### 8.2 数据源选择

两类填充器可独立或并行使用：

| 填充器 | 说明 | 网络 |
|--------|------|------|
| `local` | 用户手动或文件同步把发票文件放入 inboxDir | 无需 |
| `mailbox` | 宿主 agent 通过 IMAP 定时下载发票邮件附件到 inboxDir | 需要 |

配置 `sources.json`（放在工作目录）：

```json
{
  "version": "1.0.0",
  "mode": "local",
  "inboxDir": "./inbox",
  "outputDir": "./output",
  "schedule": "daily",
  "mailbox": {
    "enabled": false,
    "folder": "INBOX",
    "subjectFilter": "发票|报销|invoice",
    "lookbackDays": 30
  }
}
```

- `mode`: `"local"` | `"mailbox"` | `"both"`
- **IMAP 凭据**必须通过环境变量（`REBU_IMAP_USER` / `REBU_IMAP_PASS` / `REBU_IMAP_HOST` / `REBU_IMAP_PORT`）或宿主 Secret Store 提供，**不入 sources.json**。

### 8.3 inbox 文件约定

宿主 agent 或用户须将发票**提取为文本/JSON**后放入 inboxDir：

- **`.json` 文件**：符合 PortableSkillInput.invoices[*] 单项结构：
  ```json
  { "id": "inv_1", "rawText": "增值税...", "emailSubject": "...", "fileName": "..." }
  ```
- **`.txt` 文件**：纯文本内容视为 `rawText`。
- **`manifest.json`（可选）**：列出所有条目及其元数据。

> PDF/OFD/XML/OCR 的原始二进制解析由宿主 agent 负责。本模式不做二进制解析。

### 8.4 参考管线用法

```bash
cd skills/kone-expense-reimbursement

# 使用 sources.json 配置（自动读取 inbox、output、state 路径）
node scripts/collect.mjs --config ./sources.json

# 直接指定路径
node scripts/collect.mjs --inbox ./inbox --output ./output --state ./state.json

# 仅扫描报告，不执行
node scripts/collect.mjs --inbox ./inbox --dry-run
```

员工/行程信息：
- 放 `employee.json` 和 `trip.json` 在工作目录，或通过 `--employee` / `--trip` 指定路径。
- 也可通过环境变量：`REBU_EMPLOYEE_NAME`、`REBU_EMPLOYEE_ID`、`REBU_LEVEL` 等。

### 8.5 增量去重

使用 `--state ./state.json` 实现跨运行增量。已处理发票的业务键写入状态文件，下次运行自动跳过。状态文件不含原始票据文本或凭据。

### 8.6 定时调度

定时执行由 OS 或宿主负责，参考：

```bash
# macOS launchd / cron 示例（每天 9:00 执行）
0 9 * * * cd /path/to/workspace && node skills/kone-expense-reimbursement/scripts/collect.mjs --config ./sources.json
```

### 8.7 生成正式 Excel

当 portable-core 无待决项时，参考管线会提示如何调用 template-adapter：

```bash
node template-adapter/bundle.mjs \
  --template-input ./output/template-input.json \
  --output-dir ./output/bundle \
  --repo-root <仓库根目录>
```

需已获授权的公司官方模板（见 §7.6）。

### 8.8 边界

- 不依赖 Web/服务器/数据库
- 零 npm 依赖
- PDF/OFD/XML/OCR 不在范围
- 不修改 src/server/**
- 凭据只走环境变量/Secret Store

---

## 九、Agent 交互流程与首次配置（Onboarding, Spec §6.8.6.11–12）

> 目标：用户装好 Skill 后，**由宿主 Agent 引导完成配置**（选数据源、填路径、存基础信息、验网络），而不是让用户手写 `sources.json`，也不是让 Agent 每次即兴写脚本。Agent 应调用下列**固定脚本**：`setup.mjs`（配置）→ `--precheck`（网络）→ 采集器（运行）。

### 9.1 何时进入 Onboarding / 何时自动跑
- **首次**：用户说"整理报销 / 从邮箱收发票 / 定期报销"且工作目录**无** `employee.json`/`sources.json` → 走下面的引导。
- **已配置过**：若已存在 `employee.json`/`sources.json` → **不要重复询问基础信息**，直接读取、（含 mailbox 时先预检）运行采集器，且只处理**新发票**（增量去重）。做到"填一次，以后自动"。
- 仅当用户明确要"重新配置 / 换邮箱 / 改路径"时才重新进入引导。

### 9.2 标准对话步骤（Agent 逐步引导）

1. **确定数据源**（从用户的话里判断，不要让用户去理解"路径 A/B"或技术细节）：
   - 用户说"从邮箱""收邮件里的发票" → `mailbox`；给了文件夹或已粘贴发票文本 → `local`；两者都提 → `both`。不确定时用一句话问"发票在你邮箱里，还是某个文件夹里？"。
2. **本地路径**（local/both）：
   - 问 inbox 文件夹与 output 输出目录（给默认值 `./inbox`、`./output`，用户可回车接受）。
3. **基础信息**（必答，会被保存复用）：
   - 姓名、工号、部门、职位、成本中心、员工级别（`staff/manager/assistant_director/director/evp`）。
   - 写入 `employee.json`，下次自动加载，无需重复输入。
4. **邮箱信息**（mailbox/both）：
   - 服务商（`qq/163/126/gmail/outlook/yeah` 之一 → 自动带出 host/port/secure），或自定义 host/port。
   - 邮箱账号、IMAP 文件夹（默认 `INBOX`）、首次回溯天数（默认 30）。
   - **密码/授权码不进对话、不进配置**：Agent 告诉用户设置环境变量（默认 `REBU_IMAP_PASS`），只把变量名记进 `sources.json` 的 `mailbox.passwordEnv`。若宿主有 Secret Store，走安全输入通道。
5. **写配置**：Agent 用**非交互 flag** 一次性调用 `setup.mjs` 生成 `sources.json`(+`employee.json`)；先用 `--print` 预览给用户确认，再落盘。
6. **网络预检**（含 mailbox 时必做）：调用 `--precheck`。失败按 §9.4 处理。
7. **运行**：调用采集器跑完整管线；有待决项则回到人机协作（§六）。

### 9.3 Agent 调用的固定命令（非交互）

```bash
# 1) 生成配置（示例：邮箱模式，QQ 邮箱）
node scripts/local-collector/setup.mjs \
  --mode mailbox --provider qq \
  --name 张三 --employee-id K12345 --department IT --position Engineer \
  --cost-center CC100 --level staff \
  --mailbox-user zhangsan@qq.com --mailbox-folder INBOX --since-days 30 \
  --password-env REBU_IMAP_PASS \
  --workdir .            # 先加 --print 预览，确认后去掉 --print 落盘

# 2) 网络预检（不下载，仅验证连通性与凭据）
node scripts/local-collector/index.mjs --config ./sources.json --precheck

# 3) 运行完整管线（采集→提取→政策审核→可选正式 Excel）
node scripts/local-collector/index.mjs --config ./sources.json --once
```

> 纯本地模式：把 `--mode mailbox` 换成 `--mode local`，省略所有 `--mailbox-*` 与 `--password-env`。

### 9.4 邮箱网络预检与受限网络处理（Spec §6.8.6.11）

在公司网络里连接外部邮箱经常失败（如 KONE 走 Palo Alto Prisma Access/SASE，出站 IMAP 993 被网关拦截）。因此 **mailbox 模式在拉取前必须先预检**：

- 预检两阶段：TCP 连到 `host:port`（超时 8s）→ imapflow 连接并 `list()`（超时 15s）。
- 失败分类与话术：
  - **端口不可达 / 超时**（`ETIMEDOUT`/`ECONNREFUSED`）：告诉用户"可能是公司安全策略（Prisma Access/SASE）拦了外部邮箱端口（993/143）；受控电脑换网络（含手机热点）通常也绕不过。建议改用本地文件夹模式（无需邮箱），或用未纳管设备，或联系 IT 放行。"
  - **认证失败**：提示"邮箱账号或 IMAP 授权码不正确"，**不回显**任何凭据。
  - **域名解析失败**（`ENOTFOUND`）：提示检查 IMAP 服务器地址。
- `mode=both` 且预检失败：自动降级为只处理本地 inbox，并告警邮箱这次跳过。

### 9.5 凭据安全（复述）
- 密码/IMAP 授权码/JWT **绝不**写入 `sources.json`、`employee.json`、日志或对话回显。
- 仅通过环境变量（默认 `REBU_IMAP_PASS`）或宿主 Secret Store 提供。
- `setup.mjs --show` 打印配置时对敏感字段脱敏。

### 9.6 与零依赖模式的关系
- §七/§八的 `portable-core.mjs` 与 `scripts/collect.mjs` 仍是**零 npm 依赖**、纯逻辑路径，适合"宿主已提取文本"的场景。
- 本节的 `scripts/local-collector/`（含 mailbox 抓取、二进制提取）复用仓库既有依赖（`imapflow`/`pdf-parse`/`adm-zip`/`tesseract.js`），适合"要端到端自动收票"的场景。二者共用同一 `portable-core` 与政策规则。
