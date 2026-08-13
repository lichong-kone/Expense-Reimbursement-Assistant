# build-reimbursement

> Create a reimbursement record, assign invoices, run policy checks, and export Excel.

## When to use

- User says "建报销单" / "生成报销单" / "把这些发票报销" / "导出"
- After triage is complete and invoices are confirmed

## Parameters

- `name`: Reimbursement record name (e.g. "7月差旅报销"). Ask user if not provided.

## Flow

1. **Create record**: `rebu_create_reimbursement { recordName: name }`
2. **Find invoices**: `rebu_list_invoices` with appropriate filters (confirmed, unlinked)
3. **Scope preview** (before linking):
   > "找到 N 张已确认未分配的发票（合计 ¥X），将自动分配到报销单「name」。
   > 误分配可随时'移除 #ID'。我现在开始分配。"
4. **Link invoices**: `rebu_link_invoices { id, invoiceIds }` — assign relevant invoices to the record
5. **Policy checks**: `rebu_list_policy_checks { id }` — collect any warnings
6. **Review tasks**: `rebu_list_review_tasks { id }` — collect pending items
7. **Handle automatically**:
   - Review tasks that can be resolved with available info: `rebu_resolve_review_task`
8. **Three-part summary** (mandatory format):

```
── ✅ 已自动处理 ──
• 分配 N 张发票到「7月差旅报销」，合计 ¥X
• 自动处理 K 条复核任务
（误分配说"移除 #ID"，复核可重做）

── ⚠️ 仍需你决定 ──
• [check#3] 7/15 住宿超标 ¥120 → exempt（填原因）按实际报 / keep 按标准封顶
• [check#5] 7/18 餐费超标 ¥35 → exempt / keep
• [task#7] #22 缺行程单 → provide_info / defer

── 📋 下一步 ──
• 回复各项动作后，我将执行并导出 Excel。
• 报销单 ID: 42，可随时 `继续报销单 42` 恢复。
```

9. **Wait for user decisions** (normalized actions):
   - **keep**: accept as-is (for policy: cap to standard)
   - **adjust**: modify fields or amounts
   - **exempt** + reason: acknowledge override with justification → `rebu_acknowledge_policy_check { checkId, note }`
   - **provide_info** + data: supply missing information
   - **defer**: skip for now
   - **移除 #ID**: `rebu_unlink_invoice { id, invoiceId }`

10. **Export**: Once user confirms all clear → `rebu_export_reimbursement_excel { id }`

11. **Delivery message**:

```
── 📦 导出完成 ──
• 文件：7月差旅报销.xlsx（XX KB）
• 总额 ¥X / 可报销额 ¥Y
• 报销单 ID: 42 · 导出时间: 2024-07-20 14:30

恢复方式：下次对话说"继续报销单 42"即可查看/修改/重新导出。
所有发票数据已持久化，Excel 可随时重新生成。
```

## Confirm gates active

- `policy_acknowledge`: Must show policy warnings before export
- `need_confirm`: Cannot link unconfirmed invoices

## Recovery & delivery guidance

- Reimbursement record persists server-side with stable ID
- User can resume in any future session via `rebu_get_reimbursement { id }`
- Excel can be regenerated any time via `rebu_export_reimbursement_excel { id }`
- Unlink is non-destructive: invoice returns to unlinked pool
- Delivery message must NOT include absolute file paths containing local username
