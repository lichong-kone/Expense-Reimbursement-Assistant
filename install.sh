#!/usr/bin/env bash
#
# Expense Reimbursement Assistant — Skill 一键安装器（宿主中立）
#
# Skill 的通用格式是「带 YAML frontmatter 的 SKILL.md + 自包含目录」。
# 安装 = 把该目录放到你的 Agent 宿主会读取 skills 的位置。
# 目录因宿主而异（Kiro: ~/.kiro/skills；部分宿主: ~/.agents/skills），本脚本自动探测或用 --dest 指定。
#
# 用法：
#   bash install.sh                      # 装通用 Skill（kone-expense-reimbursement）
#   bash install.sh --skill service      # 装服务型 Skill（rebu-expense-agent，需另配 MCP）
#   bash install.sh --skill both         # 两个都装
#   bash install.sh --dest ~/.agents/skills
#   REBU_SKILLS_DIR=~/my/skills bash install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"

SKILL_CHOICE="universal"
DEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skill) SKILL_CHOICE="${2:-}"; shift 2 ;;
    --dest)  DEST="${2:-}"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 2 ;;
  esac
done

resolve_dest() {
  if [ -n "$DEST" ]; then printf '%s\n' "$DEST"; return; fi
  if [ -n "${REBU_SKILLS_DIR:-}" ]; then printf '%s\n' "$REBU_SKILLS_DIR"; return; fi
  if [ -d "$HOME/.kiro" ]; then printf '%s\n' "$HOME/.kiro/skills"; return; fi
  if [ -d "$HOME/.agents" ]; then printf '%s\n' "$HOME/.agents/skills"; return; fi
  echo ""
}

DEST_DIR="$(resolve_dest)"
if [ -z "$DEST_DIR" ]; then
  echo "未能自动探测宿主 skills 目录。请用 --dest 指定，例如：" >&2
  echo "  bash install.sh --dest ~/.kiro/skills" >&2
  exit 1
fi

install_one() {
  local name="$1"
  local src="$SKILLS_SRC/$name"
  [ -d "$src" ] || { echo "找不到 Skill 源目录: $src" >&2; exit 1; }
  mkdir -p "$DEST_DIR"
  cp -R "$src" "$DEST_DIR/"
  echo "  ✓ 已安装 $name → $DEST_DIR/$name"
}

echo "Skill 安装"
echo "  源:   $SKILLS_SRC"
echo "  目标: $DEST_DIR"
echo ""

case "$SKILL_CHOICE" in
  universal|portable|kone|kone-expense-reimbursement) install_one "kone-expense-reimbursement" ;;
  service|mcp|rebu-expense-agent) install_one "rebu-expense-agent" ;;
  both|all) install_one "kone-expense-reimbursement"; install_one "rebu-expense-agent" ;;
  *) echo "未知 --skill 取值: $SKILL_CHOICE（可用: universal | service | both）" >&2; exit 2 ;;
esac

echo ""
echo "重启或刷新你的 Agent 宿主后即可发现该 Skill。"
echo "服务型 Skill 还需按 README「类别一」配置 rebu MCP。"
