---
name: rebu-expense-agent
description: >
  Drive the KONE/通力 expense-reimbursement system through the REBU MCP server.
  Use when the user asks to 报销 / 整理发票 / 生成报销单 / 报销申请 / 收发票 / 核对发票 /
  连接邮箱收发票, AND the `rebu` MCP server (tools prefixed `rebu_`, resources `rebu://…`)
  is available. This skill is the OPERATING PLAYBOOK: how to orchestrate the rebu_* tools
  (auth → setup → collect → confirm → assemble → check → export → recycle) with the right
  human-in-the-loop discipline. It does NOT re-implement parsing/policy — the REBU backend
  already does that; here you only call tools. For the underlying domain rules (policy limits,
  extraction, Excel mapping) see the companion skill `kone-expense-reimbursement`.
---

# REBU 报销助手（驱动 rebu MCP）

## 模式路由（单入口决策）

当用户意图为"整理报销/生成报销单"时，按以下顺序决定进入哪个 skill：

1. **检测 REBU MCP 可用性**：宿主能看到 `rebu_*` 工具与 `rebu://…` 资源。
2. **进入服务型 skill（本 skill）的条件**：MCP 可用，且用户需要邮箱同步、持久化报销单、受控模板或正式 Excel 导出。
3. **进入 portable skill 的条件**：用户明确要求离线处理，REBU 服务不可达，或仅处理本地已提取文本/结构化资料。
4. **两者均可用但意图不明确时**：只询问一次——"连接 REBU 完整处理，还是离线分析本地资料？"不得同时启动两个 skill。

> ⚠️ 本 skill 为 **service 型**，全部数据操作通过 REBU MCP 工具执行。
> portable skill 的交互规范（`--init`/`--validate`/`--decisions`）不适用于本 skill。

---

## 铁律（贯穿全程）

1. **认证优先**：任何报销动作前，先确认已认证。
2. **凭据不入普通对话**：账号密码、IMAP 授权码与 JWT **不得在 Agent 普通消息中索取、回显或记录**。凭据必须通过宿主的安全输入/Secret Store 采集（如 WorkBuddy 密钥输入面板）；若宿主无安全输入能力，提示用户"请在本地环境变量或受保护配置文件中设置 `REBU_USERNAME`/`REBU_PASSWORD`（或 `REBU_MCP_TOKEN`），然后重新启动会话"。IMAP 授权码同理——仅在安全输入通道中传递，普通文本消息不得包含其值。
3. **自主优先、末尾统一确认**：凡能自己确定的（字段完整、非 `need_confirm`、无政策提示）就自动做掉，不逐张打断用户；不能确定的攒起来，末尾一次性交用户拍板。
4. **自动处理前先预告**：首次批量自动处理前，必须先说明：
   - 本次可自动处理的范围（例如"N 张字段完整、高置信的发票将自动核验归类"）
   - 撤销方式（"如有误，可随时说'撤销'或'恢复'，所有操作均可逆——核验可 `rebu_confirm_invoice {verified:false}` 撤销，删除走软删可恢复"）
5. **软删安全**：删除都是软删，可 `rebu_restore_invoice` 恢复；仍应先说明再删。
6. **政策只提示不阻断**：超标/超期/缺件是提示项，交用户决定，不擅自删改金额。
7. **摘要不泄露隐私**：输出摘要不得包含凭据值、绝对本机路径中的用户名、或原始票据全文。
8. **文件只由 rebu_* 工具产出，严禁自行生成/改写**：所有报销文件（尤其 Excel）**只能**由 rebu MCP 工具生成——《费用报销单》走 `rebu_export_reimbursement_excel`（公司官方模板，与 Web 预览/邮件附件同一事实源）。**严禁**用 Python、openpyxl、pandas、脚本或任何"按自己理解拼装"的方式生成、修改或替代报销文件；**不得**把手工拼的工作簿称为"正式/符合模板/官方格式"的文件。
9. **产不出就停下并如实告知，绝不自行替代**：若某目标文件当前 Skill/MCP 没有对应工具，**停止并明确告诉用户"暂不支持"**，不得自行生成替代版本。
   - **《费用报销单》→ `rebu_export_reimbursement_excel`；《出差申请表》→ `rebu_export_travel_request`**（仅出差类型且有行程时可用）。
   - `rebu_export_travel_request` 在非出差 / 无行程时会返回明确错误 → 如实转告用户"该单不适用出差申请表"，**不得**用 Python/手工造表替代。

> 固定指令（可直接粘贴给 Agent）：严格使用 rebu-expense-agent，所有报销操作仅调用 `rebu_*` 工具。禁止用 Python、openpyxl 或其他方式自行生成/修改 Excel。若 Skill 或 MCP 无法生成目标文件，停止并明确告知，不得自行替代。

---

## 统一审核语言（两 skill 共享）

对待确认项和政策提示，用户可执行以下标准化动作：

| 动作 | 语义 | 适用场景 |
|------|------|----------|
| **保留原值（keep）** | 接受当前抽取/归类结果 | 信息完整但被标疑 |
| **调整信息或金额（adjust）** | 修正字段后确认 | 抽取有误、金额需修正 |
| **申请豁免并说明原因（exempt）** | 承认超标/超期但提供豁免理由 | 政策提示类，reason 必填 |
| **补充信息（provide_info）** | 补全缺失字段 | 缺日期/路线/参与人等 |
| **稍后处理（defer）** | 本次跳过，不做决定 | 暂无法确定的项 |

呈现每个待决项时：
- 标注稳定 `questionId` / `checkId`
- 给出建议动作（如"建议 keep"或"建议 adjust: city → 上海"）
- 说明影响（如"超标 ¥42，按实际报需填原因"）

---

## 标准编排（按序，能跳过已满足的步骤）

### 步骤 0 · 认证

1. `rebu_auth_status`。
2. 若 `authenticated=false`：**不在普通消息中索取密码**。引导用户通过宿主安全输入面板提供凭据，或提示设置环境变量 `REBU_USERNAME` / `REBU_PASSWORD`。
3. 凭据到位后 `rebu_authenticate {username, password, name?}` —— 账号不存在会自动注册再登录，令牌本地缓存，之后免问。
4. 认证成功后继续；失败（如"账号已存在但密码不正确"）如实告知并请用户通过安全通道重新提供。

### 步骤 1 · 配置自检 / onboarding

1. `rebu_get_setup_status`（或读资源 `rebu://setup-status`）。
2. `ready=true` → 直接进入步骤 2，不要再问配置。
3. `mailboxConfigured=false` → 向用户索取：邮箱地址、服务商（qq/163/gmail/custom），IMAP 授权码通过安全输入通道；custom 另需服务器/端口（通常 993）/是否 SSL。`rebu_add_mailbox` 绑定 → `rebu_test_mailbox` 验连通（失败报错重试）。
4. `profileComplete=false` → 索取缺失的员工元数据（姓名 name、工号 employeeNo、部门 department、成本中心 costCenter，可选 employeeType/title）→ `rebu_update_profile`。

### 步骤 2 · 取票

- `rebu_sync_inbox`（默认当前账号；用户明确要补历史时传 `dateFrom`）。
- 完成后可 `rebu_get_inbox` 看概览。

### 步骤 3 · 分诊（自主处理 + 收集存疑）

1. `rebu_list_needs_attention` 拿全景；`rebu_list_pending_confirmations` 拿 `need_confirm` 队列。
2. **自动处理前预告**（首次进入此步骤时必须声明）：
   > "本次可自动处理 N 张字段完整、高置信的发票（核验归类）。如有误，可随时'撤销核验'或从回收站恢复。我现在开始自动处理。"
3. 对**能确定**的发票：必要时 `rebu_update_invoice_fields` 补正，`rebu_confirm_invoice` 核验归类——自动做，不逐张问。
4. 对**存疑**的（抽取不确定、缺字段、疑似重复、可能超标）：先不动，记下每张的存疑点与建议。

### 步骤 4 · 建单与分配（按需）

- `rebu_create_reimbursement {recordName}` → `rebu_list_invoices`（找已归类的相关票）→ `rebu_link_invoices {id, invoiceIds}`。
- 误放可 `rebu_unlink_invoice`。

### 步骤 5 · 校验

- `rebu_list_policy_checks {id}` / `rebu_list_review_tasks {id}`：收集超标/待确认项。
- 可处理的复核项 `rebu_resolve_review_task`；政策项确认/豁免 `rebu_acknowledge_policy_check`（记原因）。

### 步骤 6 · 三段式汇总（关键）

完成自动处理后，向用户呈现以下三段式摘要：

```
── ✅ 已自动处理 ──
• 核验确认：N 张发票（列出简要：#12 滴滴 ¥45、#13 美团 ¥38…）
• 分配到报销单：M 张

── ⚠️ 仍需你决定 ──
• [#14] 餐费 ¥128 · 城市未识别 → 建议 adjust: city → 北京  |  keep / adjust / defer
• [#15] 住宿 ¥520 · 超标 ¥120 → 建议 exempt（需填原因） |  keep / adjust / exempt / defer
• [政策] 7月15日餐费合计 ¥185 超日限额 ¥150 → 按标准报 or 按实际报（填原因）

── 📋 下一步 ──
• 回复各待决项的动作后，我将执行并导出 Excel。
• 如需撤销已自动处理的项，说"撤销 #12"即可。
```

等用户答复后，用步骤 3/4/5 的工具落实其决定。

### 步骤 7 · 导出与交付

- 用户确认无误 → `rebu_export_reimbursement_excel {id}`，返回文件路径交付。
- **出差类型**且有行程时，可再调用 `rebu_export_travel_request {id}` 导出《出差申请表》；非出差/无行程会返回明确错误，如实转告，**不得**用 Python/手工造表替代（见铁律 8/9）。
- 交付时附带：
  - 文件名与大小
  - 报销单总额 / 可报销额
  - 如何恢复：说明可从本次会话的报销单 ID 和同步状态恢复；下次对话可直接 `rebu_get_reimbursement {id}` 继续。

### 回收站（随时）

- 删：`rebu_delete_invoice`（先确认门）；看回收站：`rebu_list_deleted_invoices`；恢复：`rebu_restore_invoice`。

---

## 恢复与接续指引

- **中断恢复**：用户下次对话可说"继续上次报销"，Agent 应先 `rebu_auth_status` → `rebu_list_reimbursements` 找到未完成的单据继续。
- **决定可重做**：任何已核验的发票可 `rebu_confirm_invoice {verified:false}` 撤销；已确认的政策项可由用户要求重新审视。
- **输出可追溯**：导出后提供报销单 ID、导出时间，用户可据此下次会话 `rebu_get_reimbursement` 查看完整记录。
- **隐私安全**：恢复说明中不包含凭据值、不以绝对路径暴露本机用户名。

---

## 意图 → 工具速查

| 用户说 | 调 |
|---|---|
| "登录 / 我要用 xxx 账号" | 引导安全输入 → `rebu_authenticate` |
| "配置好了没 / 帮我连邮箱" | `rebu_get_setup_status` → `rebu_add_mailbox`/`rebu_update_profile` |
| "同步/收一下发票" | `rebu_sync_inbox` |
| "有哪些要我确认的" | `rebu_list_needs_attention` / `rebu_list_pending_confirmations` |
| "第几张改成…并确认" | `rebu_update_invoice_fields` → `rebu_confirm_invoice` |
| "保留原值 / keep #14" | `rebu_confirm_invoice` |
| "调整 #14 城市为上海" | `rebu_update_invoice_fields` → `rebu_confirm_invoice` |
| "豁免 #15，原因是客户接待" | `rebu_acknowledge_policy_check {note}` |
| "稍后处理 #16" | 标记 defer，不执行操作 |
| "建个 7 月打车报销单，把这些放进去" | `rebu_create_reimbursement` → `rebu_link_invoices` |
| "有没有超标/缺行程单" | `rebu_list_policy_checks` / `rebu_list_review_tasks` |
| "导出" | `rebu_export_reimbursement_excel` |
| "撤销 #12 的核验" | `rebu_confirm_invoice {invoiceId:12, verified:false}` |
| "删错了 / 找回" | `rebu_list_deleted_invoices` → `rebu_restore_invoice` |

---

## 错误处理

- 令牌过期（401）：MCP 会用缓存的 refreshToken 自动续期，一般无需处理；若续期失败则重新走步骤 0。
- 邮箱连通失败：把 `rebu_test_mailbox` 的错误如实转达（多为授权码/服务器/端口问题），请用户更正后重试。
- 工具返回 `ok:false`：读取 `error.message` 转达，不要臆造成功。
- 导出失败：告知用户可稍后重试 `rebu_export_reimbursement_excel {id}`，数据已持久化不会丢失。

---

## 现成提示（可直接触发）

`setup_onboarding`（首次配置引导）、`triage_inbox`（同步+分诊）、`verify_pending`（逐张核对）、
`build_reimbursement {name}`（建单→分配→校验→导出）。这些已内建本 skill 的编排，可优先复用。

---

## 与领域 skill 的关系

本 skill 只讲"怎么用 rebu MCP"。具体政策数值、字段口径、Excel 映射由后端实现，背景知识见
`kone-expense-reimbursement` skill 与主 Spec `docs/spec/REBU_SYSTEM_SPEC.md`、
`docs/spec/REBU_MCP_INTERFACE_SPEC.md`。
