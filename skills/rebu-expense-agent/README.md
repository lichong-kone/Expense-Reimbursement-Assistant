# rebu-expense-agent

> Service-type Agent Skill for the REBU expense-reimbursement system.

## Overview

This skill drives the KONE/通力 expense-reimbursement workflow through the REBU MCP server. It handles the complete lifecycle: authentication → mailbox setup → invoice sync → triage → reimbursement assembly → policy checks → export, all with human-in-the-loop confirmation gates.

- **Type**: Service (requires running REBU API backend)
- **Transport**: MCP over stdio
- **Tools**: 32 (dynamically exported from the MCP server)
- **Version**: 1.1.0 (§6.8.3 service-mode UX)

## §6.8.3 Service-Mode UX Features

### Mode Routing
- Explicit service-vs-portable routing: skill activates only when REBU MCP is available AND user needs online features (mailbox sync, persistent records, Excel export).
- Single disambiguation prompt when intent is ambiguous; never runs both skills simultaneously.

### Credential Safety
- Credentials (passwords, IMAP auth codes, JWT) are NEVER solicited or echoed in normal Agent chat.
- All sensitive values must come via Secret Store, secure input panel, or environment variables.
- `credential_handoff: secret_store_or_env` declared in manifest for each sensitive env var.

### Auto-Processing Scope Preview
- Before any batch auto-action, Agent presents what will be processed and how many items.
- Reversibility disclosed: every auto-action states its undo path (撤销核验, 恢复软删).

### Three-Part Summary
Every triage/build cycle ends with a structured summary:
1. **已自动处理** — what was done autonomously
2. **仍需决定** — items requiring user action (with recommendations)
3. **下一步** — clear next action for user

### Normalized Review Actions
Consistent user-facing vocabulary across all prompts:
| Action | Label |
|--------|-------|
| keep | 保留原值 |
| adjust | 调整信息或金额 |
| exempt | 申请豁免并说明原因 |
| provide_info | 补充信息 |
| defer | 稍后处理 |

### Recovery & Delivery Guidance
- Every output includes recovery instructions (reimbursement ID, how to resume).
- Summaries never expose credentials or local usernames in paths.
- Excel can be regenerated at any time from persisted server-side data.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Operating playbook — orchestration logic and tool usage patterns |
| `manifest.json` | Machine-readable skill manifest (type, env, capabilities, confirm gates, routing, review actions) |
| `config.yaml` | WorkBuddy-compatible configuration |
| `tools.json` | MCP tool snapshot (auto-generated, do not hand-edit) |
| `prompts/*.md` | Reusable prompt templates for common workflows |
| `README.md` | This file |

## Prerequisites

1. A running REBU API server (local or remote)
2. `REBU_API_BASE` environment variable pointing to the server
3. Credentials provided via Secret Store or environment variables (never in chat)

## Quick Start

```bash
# 1. Set the API base URL
export REBU_API_BASE=http://127.0.0.1:3001

# 2. Optionally pre-configure auth (avoids interactive prompt)
export REBU_USERNAME=your_username
export REBU_PASSWORD=your_password

# 3. Build the MCP server (if not already built)
npm run build:mcp

# 4. Connect via any MCP-compatible client
# The skill is available at: dist/mcp/rebu-mcp-server.js
```

## Tool Snapshot Generation

The `tools.json` file is auto-generated from the live MCP server. To regenerate:

```bash
# Requires dist/mcp/rebu-mcp-server.js to exist (run build:mcp first)
node scripts/export-mcp-tools.cjs
```

This spawns the MCP server via stdio, calls `tools/list`, and writes the response to `skills/rebu-expense-agent/tools.json`. **Do not hand-edit** `tools.json` — it must stay in sync with the runtime server.

## Confirmation Gates

The skill enforces explicit user confirmation before:

| Gate | Trigger | User Actions |
|------|---------|--------------|
| `need_confirm` | Invoice with low-confidence extraction, missing fields, or suspected duplicate | keep / adjust / provide_info / defer |
| `policy_acknowledge` | Policy check warning (over-limit, over-time, missing supporting docs) | keep / exempt (+reason) / adjust |
| `delete_invoice` | Soft-delete operation (reversible via restore) | approve / cancel |
| `send_email` | Any outbound email action | approve / cancel |

## Companion Skill

This skill works alongside `kone-expense-reimbursement` (portable domain-knowledge skill) which provides policy rules, field mappings, and extraction context. The companion is optional — the REBU backend already implements all business logic.

## Security

- Credentials (`REBU_MCP_TOKEN`, `REBU_USERNAME`, `REBU_PASSWORD`, IMAP auth codes) are marked as sensitive in the manifest
- No credentials are stored in skill files or solicited in normal chat messages
- `credential_handoff: secret_store_or_env` ensures host knows to use secure input
- The skill only connects to the explicitly configured `REBU_API_BASE`
- Token cache is stored with mode 0600 at `~/.rebu-mcp/state.json`
- Output summaries never expose credential values or full local filesystem paths
