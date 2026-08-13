#!/usr/bin/env bash
#
# 报销一条命令入口。始终运行同一条命令，脚本自动推进：
#
#   bash reimburse.sh reimbursement.json
#
#   第 1 次：生成可编辑骨架，填入员工/行程/已提取发票文本。
#   第 2 次：校验、整理、审核；无待决项则直接生成正式 Excel，有超标项则提示填写决定。
#   第 3 次：决定已填 → 自动应用并生成正式《费用报销单》Excel。
#
# 需要 Node.js >= 18。政策/整理/审核零依赖；生成正式 Excel 需 adm-zip（脚本会自动安装）。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$SCRIPT_DIR/skills/kone-expense-reimbursement"
CORE="$SKILL/portable-core.mjs"
BUNDLE="$SKILL/template-adapter/bundle.mjs"

INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  echo "用法: bash reimburse.sh reimbursement.json"
  echo "（首次运行会在该路径生成可编辑骨架）"
  exit 1
fi

NODE_MAJOR="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：需要 Node.js >= 18（当前：$(node --version 2>/dev/null || echo '未安装')）" >&2
  exit 1
fi
[ -f "$CORE" ] || { echo "错误：找不到 Skill 核心 $CORE" >&2; exit 1; }

base="${INPUT%.json}"
OUT_DIR="${base}-output"
REVIEWED_DIR="${base}-reviewed"
TEMPLATE="$OUT_DIR/review-decisions.template.json"
STATE="${base}-state.json"        # 跨运行增量去重状态（自动维护）
EXCEL_DIR="${base}-excel"         # 正式 Excel 输出目录

# 确保 adm-zip 可用（仅生成正式 Excel 需要；政策核心不需要）。
ensure_admzip() {
  if node -e "require.resolve('adm-zip')" >/dev/null 2>&1; then return 0; fi
  if command -v npm >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/package.json" ]; then
    echo "  安装正式 Excel 渲染依赖 adm-zip …"
    ( cd "$SCRIPT_DIR" && npm install --no-audit --no-fund --loglevel=error ) || return 1
    node -e "require.resolve('adm-zip')" >/dev/null 2>&1
  else
    return 1
  fi
}

# 从给定 template-input.json 渲染正式 Excel。
render_excel() {
  local tinput="$1"
  if ensure_admzip; then
    node "$BUNDLE" --template-input "$tinput" --output-dir "$EXCEL_DIR" >/dev/null
    local x
    x="$(find "$EXCEL_DIR" -name '*.xlsx' 2>/dev/null | head -1 || true)"
    echo "✓ 正式《费用报销单》Excel：$x"
    echo "  校验结论见 $EXCEL_DIR/bundle-summary.md（是否可递交）。"
  else
    echo "⚠ 生成正式 Excel 需要 adm-zip：在仓库根运行 npm install 后重跑本命令。"
    echo "  当前已产出结构化结果，可交由宿主/内部适配器渲染。"
  fi
}

# 无待确认/待决项时返回 0（可直接出正式 Excel）。
no_pending() {
  local dir="$1"
  node -e "const fs=require('fs');const q=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.exit(Array.isArray(q)&&q.length===0?0:1)" "$dir/review-questions.json" 2>/dev/null
}

# 步骤 1：输入不存在 → 生成骨架
if [ ! -f "$INPUT" ]; then
  node "$CORE" --init "$INPUT"
  echo ""
  echo "下一步：编辑 $INPUT 填入员工/行程/发票信息，然后再次运行同一条命令："
  echo "  bash reimburse.sh $INPUT"
  exit 0
fi

# 决定模板是否已填（任一非空 action）
decisions_ready=false
if [ -f "$TEMPLATE" ]; then
  if node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.exit(Array.isArray(d)&&d.some(x=>x&&typeof x.action==='string'&&x.action.trim())?0:1)" "$TEMPLATE" 2>/dev/null; then
    decisions_ready=true
  fi
fi

# 步骤 3：决定已填 → 应用并生成正式 Excel
if [ "$decisions_ready" = true ]; then
  node "$CORE" --input "$INPUT" --decisions "$TEMPLATE" --output-dir "$REVIEWED_DIR" --state "$STATE"
  echo ""
  echo "✓ 已应用审核决定：$REVIEWED_DIR/（summary.md 含实际/可报销总额、已应用决定）"
  render_excel "$REVIEWED_DIR/template-input.json"
  exit 0
fi

# 步骤 2：校验 + 整理 + 审核（--state 自动增量去重）
node "$CORE" --validate --input "$INPUT"
node "$CORE" --input "$INPUT" --output-dir "$OUT_DIR" --state "$STATE"
echo ""
echo "✓ 审核包已生成：$OUT_DIR/（阅读 summary.md）"
if no_pending "$OUT_DIR"; then
  # 无待决项 → 直接出正式 Excel
  render_excel "$OUT_DIR/template-input.json"
else
  echo "  有超标/待确认项：编辑 $TEMPLATE 填写每项 action"
  echo "  （keep 保留 / adjust 调整 / exempt 豁免并填 reason / provide_info 补充 / defer 稍后），"
  echo "  然后再次运行同一条命令，自动应用并生成正式 Excel："
  echo "    bash reimburse.sh $INPUT"
fi
