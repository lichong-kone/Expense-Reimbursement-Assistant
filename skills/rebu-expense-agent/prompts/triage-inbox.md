# triage-inbox

> Sync mailbox and triage incoming invoices: auto-confirm what's clear, collect what needs user input.

## When to use

- User says "同步发票" / "收一下发票" / "有新发票吗"
- `rebu_start_session` returns `nextStep: "triage"`

## Flow

1. **Sync**: Call `rebu_sync_inbox` (default current account; pass `dateFrom` only if user explicitly wants history).
2. **Overview**: Call `rebu_get_inbox` to see what arrived.
3. **Attention list**: Call `rebu_list_needs_attention` + `rebu_list_pending_confirmations`.
4. **Scope preview** (MUST present before auto-processing):
   > "本次收到 X 张发票。其中 N 张字段完整、置信度高，我将自动核验归类。M 张存疑需你决定。
   > 自动处理可随时撤销：说'撤销 #ID'即可取消核验，删除均为软删可恢复。
   > 我现在开始自动处理。"
5. **Auto-process** (after preview, do NOT ask user per-item):
   - For invoices where fields are complete and confidence is high: `rebu_confirm_invoice`
   - For invoices needing minor field fixes you can determine: `rebu_update_invoice_fields` → `rebu_confirm_invoice`
6. **Collect uncertainties**: For each invoice that is `need_confirm`, low-confidence, missing fields, or suspected duplicate — note the issue and your suggestion but do NOT act.
7. **Three-part summary** (single message, mandatory format):

```
── ✅ 已自动处理 ──
• 核验确认 N 张：#12 滴滴出行 ¥45.0、#13 美团外卖 ¥38.5…
（如有误，说"撤销 #ID"可逆）

── ⚠️ 仍需你决定 ──
• [#14] 餐费 ¥128 · 城市未识别
  → 建议 adjust: city → 北京 | 可选：keep / adjust / provide_info / defer
• [#15] 住宿 ¥520 · 超日限额 ¥120
  → 建议 exempt（需填原因）| 可选：keep / adjust / exempt / defer
• [#16] 出租车 ¥62 · 缺起止地点
  → 建议 provide_info: 补充路线 | 可选：provide_info / defer

── 📋 下一步 ──
• 回复各项动作（如"keep #14, adjust #16 路线=公司→客户现场"），我将执行。
• 全部确认后可建报销单并导出。
```

8. **Wait for user decisions**, then execute using normalized actions:
   - keep → `rebu_confirm_invoice`
   - adjust → `rebu_update_invoice_fields` + `rebu_confirm_invoice`
   - exempt → `rebu_acknowledge_policy_check` (reason required)
   - provide_info → `rebu_update_invoice_fields` with provided data
   - defer → no action, leave for next session

## Key principles

- **Scope preview before action**: user must know what will be auto-processed and how to undo
- **Reversible disclosure**: every auto-action is stated with its undo path
- **Autonomous-first**: don't interrupt for things you can determine
- **Batch confirmation**: collect all uncertainties, present once at the end
- **Normalized actions**: use keep/adjust/exempt/provide_info/defer vocabulary consistently
- **Soft-delete safety**: any deletions require user acknowledgment
- **No credentials in output**: summaries never contain auth tokens or passwords
