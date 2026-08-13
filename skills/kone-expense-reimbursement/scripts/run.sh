#!/usr/bin/env bash
# KONE Expense Reimbursement Portable Skill — Runner Script
# Usage: ./scripts/run.sh <input.json> [output-dir]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
CORE="${SKILL_DIR}/portable-core.mjs"

INPUT="${1:-}"
OUTPUT_DIR="${2:-./output}"

if [ -z "$INPUT" ]; then
  echo "Usage: $0 <input.json> [output-dir]"
  echo ""
  echo "Run the KONE expense reimbursement portable skill."
  echo "Requires Node.js >= 18. Zero external dependencies."
  exit 1
fi

# Check Node version
NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js >= 18 required (found: $(node --version 2>/dev/null || echo 'none'))"
  exit 1
fi

exec node "$CORE" --input "$INPUT" --output-dir "$OUTPUT_DIR"
