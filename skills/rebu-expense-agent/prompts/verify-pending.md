# verify-pending

> Walk through pending-confirmation invoices with user, resolve each one using normalized review actions.

## When to use

- User says "有哪些要确认的" / "帮我看看待确认" / "核对发票"
- After triage identified items needing user input

## Flow

1. **List pending**: `rebu_list_pending_confirmations` — get all `need_confirm` invoices
2. **Also check**: `rebu_list_needs_attention` for broader issues (policy warnings, review tasks)
3. **Present grouped summary** using normalized action vocabulary:

```
── ⚠️ 待确认项（共 Y 张）──

▸ 信息缺失（M 张）
  [#16] 出租车 ¥62 · 2024-07-12 · 缺起止地点
    → 建议 provide_info: 补充路线 | keep / adjust / provide_info / defer
  [#18] 餐费 ¥95 · 缺日期
    → 建议 provide_info: 补充日期 | keep / adjust / provide_info / defer

▸ 置信度低 / OCR 存疑（K 张）
  [#20] 住宿 ¥380 · 金额 OCR 不确定（可能 ¥380 或 ¥880）
    → 建议 adjust: amount → 核实后告知 | keep / adjust / defer

▸ 疑似重复（J 张）
  [#22] 与 #11 疑似重复（同日/同额/同商户）
    → 建议 keep 一张，另一张 defer 或删除 | keep / defer / 删除

▸ 政策提示（P 条）
  [check#5] 7/15 餐费合计 ¥185 超日限额 ¥150（超 ¥35）
    → 按标准报（自动封顶）或 exempt: 按实际报（需填原因）
```

4. **Process user decisions** (map to tool calls):
   - **keep** → `rebu_confirm_invoice { invoiceId, verified: true }`
   - **adjust** + field data → `rebu_update_invoice_fields { invoiceId, fields }` → `rebu_confirm_invoice`
   - **exempt** + reason → `rebu_acknowledge_policy_check { checkId, note: reason }`
   - **provide_info** + data → `rebu_update_invoice_fields { invoiceId, fields }` → `rebu_confirm_invoice`
   - **defer** → no action; leave for next session
   - **删除** → confirm gate (mention "软删，可从回收站恢复") → `rebu_delete_invoice`

5. **Completion summary** (three-part):

```
── ✅ 已处理 ──
• 确认 X 张，调整 Y 张，豁免 Z 条政策项

── ⏳ 已跳过（defer） ──
• #18、#22 留待下次处理

── 📋 下一步 ──
• 可继续建报销单（说"建报销单"），或下次对话继续处理剩余项。
• 已处理的项可随时撤销：说"撤销 #ID"。
```

## Key principles

- Present all pending items at once (batch, not one-by-one interrupts)
- Use normalized action vocabulary: keep / adjust / exempt / provide_info / defer
- Always show stable questionId/checkId for traceability
- Always show your recommendation alongside each issue
- Always state impact (金额影响、后续流程影响)
- Deletions go through confirm gate (mention recoverability from recycle bin)
- Never fabricate invoice data — only fill what can be determined from context
- Summaries never include credentials or absolute paths with usernames

## Recovery guidance

- Deferred items persist server-side; next session `rebu_list_pending_confirmations` will still show them
- Confirmed items can be un-confirmed: `rebu_confirm_invoice { verified: false }`
- Deleted items recoverable: `rebu_list_deleted_invoices` → `rebu_restore_invoice`
