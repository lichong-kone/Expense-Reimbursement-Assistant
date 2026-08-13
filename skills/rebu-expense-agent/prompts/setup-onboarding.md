# setup-onboarding

> First-time configuration guide: authenticate, connect mailbox, complete profile.

## When to use

- User is new or `rebu_start_session` returns `nextStep: "authenticate"` or `"onboarding"`
- User says "帮我连邮箱" or "配置"

## Flow

1. **Check auth**: Call `rebu_auth_status`. If not authenticated:
   - Do NOT ask for password in normal chat text.
   - If host supports secure input (Secret Store / credential panel): request credentials through that channel.
   - Otherwise: tell user "请在环境变量中设置 `REBU_USERNAME` 和 `REBU_PASSWORD`（或预签 `REBU_MCP_TOKEN`），然后重新启动会话。"
   - Once credentials are available via secure channel: `rebu_authenticate`.
2. **Check setup**: Call `rebu_get_setup_status`.
3. **Mailbox** (if `mailboxConfigured=false`):
   - Ask in normal chat: email address, provider (qq/163/gmail/custom)
   - For IMAP auth code: request via host secure input channel only. If unavailable: "请在安全配置中提供 IMAP 授权码，不要在对话中直接粘贴。"
   - If custom: also ask server, port (default 993), SSL (default true) — these are non-sensitive, can be in chat.
   - Call `rebu_add_mailbox` → `rebu_test_mailbox`
   - On failure: report error, ask user to verify auth code (via secure channel) and retry
4. **Profile** (if `profileComplete=false`):
   - Ask for missing fields: name, employeeNo, department, costCenter
   - Optional: employeeType, title
   - Call `rebu_update_profile`
5. **Confirm**: Summarize what was configured, suggest next step (sync inbox)

## Credential safety rules

- Never echo back passwords or IMAP auth codes in output
- Never include credential values in conversation history or summaries
- Use them only in the immediate tool call parameter
- If user pastes a credential in normal chat despite guidance, use it for the tool call but do NOT repeat it back; remind them to use secure input next time
