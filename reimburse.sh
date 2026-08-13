#!/usr/bin/env bash
#
# 报销一条命令入口（通用 Skill）。始终运行同一条命令，脚本自动推进：
#
#   bash reimburse.sh reimbursement.json
#
#   第 1 次：生成可编辑骨架，填入员工/行程/已提取发票文本。
#   第 2 次：校验并生成审核包；如有超标项，填写 <name>-output/review-decisions.template.json。
#   第 3 次：检测到决定已填，自动应用，产出 <name>-reviewed/。
#
# 需要 Node.js >= 18；零依赖；离线。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$SCRIPT_DIR/skills/kone-expense-reimbursement/portable-core.mjs"

INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  echo "用法: bash reimburse.sh reimbursement.json"
  echo "（首次运行会在该路径生成可编辑骨架）"
  exit 1
fi

# Node 版本检查
NODE_MAJOR="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：需要 Node.js >= 18（当前：$(node --version 2>/dev/null || echo '未安装')）" >&2
  exit 1
fi
if [ ! -f "$CORE" ]; then
  echo "错误：找不到 Skill 核心 $CORE" >&2
  exit 1
fi

base="${INPUT%.json}"
OUT_DIR="${base}-output"
REVIEWED_DIR="${base}-reviewed"
TEMPLATE="$OUT_DIR/review-decisions.template.json"

# 步骤 1：输入不存在 → 生成骨架
if [ ! -f "$INPUT" ]; then
  node "$CORE" --init "$INPUT"
  echo ""
  echo "下一步：编辑 $INPUT 填入员工/行程/发票信息，然后再次运行同一条命令："
  echo "  bash reimburse.sh $INPUT"
  exit 0
fi

# 判断决定模板是否已填（存在任一非空 action）
decisions_ready=false
if [ -f "$TEMPLATE" ]; then
  if node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.exit(Array.isArray(d)&&d.some(x=>x&&typeof x.action==='string'&&x.action.trim())?0:1)" "$TEMPLATE" 2>/dev/null; then
    decisions_ready=true
  fi
fi

# 步骤 3：决定已填 → 应用决定
if [ "$decisions_ready" = true ]; then
  node "$CORE" --input "$INPUT" --decisions "$TEMPLATE" --output-dir "$REVIEWED_DIR"
  echo ""
  echo "✓ 已应用你的审核决定，最终结果在：$REVIEWED_DIR/"
  echo "  查看 $REVIEWED_DIR/summary.md（含实际/可报销总额、已应用决定、下一步）。"
  echo "  正式《费用报销单》Excel 由公司内部适配器从官方模板生成（本公开包不含）。"
  exit 0
fi

# 步骤 2：校验 + 处理，生成审核包
node "$CORE" --validate --input "$INPUT"
node "$CORE" --input "$INPUT" --output-dir "$OUT_DIR"
echo ""
echo "✓ 审核包已生成：$OUT_DIR/"
echo "  阅读 $OUT_DIR/summary.md 查看总额与政策提示。"
if [ -f "$TEMPLATE" ]; then
  echo "  如有超标/待确认项：编辑 $TEMPLATE 填写每项 action"
  echo "  （keep 保留 / adjust 调整 / exempt 豁免并填 reason / provide_info 补充 / defer 稍后），"
  echo "  然后再次运行同一条命令自动应用："
  echo "    bash reimburse.sh $INPUT"
fi
