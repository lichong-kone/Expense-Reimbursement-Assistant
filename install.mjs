#!/usr/bin/env node
/**
 * Expense Reimbursement Assistant — 跨平台 Skill 安装器（Node 版）
 *
 * Windows / macOS / Linux 一条命令通用（只需 Node 18+）。
 *
 * 用法：
 *   node install.mjs --host copilot          # 装到 Copilot CLI 的 skills 目录
 *   node install.mjs --host kiro             # 装到 Kiro
 *   node install.mjs --host claude|agents    # 装到 Claude / 通用 .agents
 *   node install.mjs --dest <目录>           # 指定任意 skills 目录
 *   node install.mjs --skill service ...     # 装服务型 Skill（需另配 MCP）
 */

import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC = join(__dirname, 'skills');

const SKILL_MAP = {
  universal: 'kone-expense-reimbursement',
  portable: 'kone-expense-reimbursement',
  kone: 'kone-expense-reimbursement',
  'kone-expense-reimbursement': 'kone-expense-reimbursement',
  service: 'rebu-expense-agent',
  mcp: 'rebu-expense-agent',
  'rebu-expense-agent': 'rebu-expense-agent',
};

// Per-host personal skills directory (relative to $HOME). A universal skill must
// go under the Agent you actually run — there is no reliable way to guess that
// from the filesystem, so we require --host/--dest instead of defaulting.
const HOST_DIRS = {
  copilot: '.copilot/skills',   // GitHub Copilot CLI (also supports ~/.agents/skills)
  kiro:    '.kiro/skills',      // Kiro
  claude:  '.claude/skills',    // Claude
  agents:  '.agents/skills',    // 通用 AGENTS.md 生态（含 Copilot CLI）
};

function parseArgs(argv) {
  const args = { skill: 'universal', dest: '', host: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skill') args.skill = argv[++i];
    else if (a === '--dest') args.dest = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`未知参数: ${a}（--help 查看用法）`); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`Skill 安装器（Node 版，跨平台）

选择你实际使用的 Agent（不同 Agent 的 skills 目录不同）：
  node install.mjs --host copilot    → ~/.copilot/skills   (GitHub Copilot CLI)
  node install.mjs --host kiro       → ~/.kiro/skills      (Kiro)
  node install.mjs --host claude     → ~/.claude/skills    (Claude)
  node install.mjs --host agents     → ~/.agents/skills    (通用 .agents)
  node install.mjs --dest <目录>     → 任意自定义 skills 目录

其它：
  --skill universal|service|both     选择要装的 Skill（默认 universal）`);
}

function fail(msg) { console.error(msg); process.exit(1); }

function resolveDest(dest, host) {
  if (dest) return dest;
  if (process.env.REBU_SKILLS_DIR) return process.env.REBU_SKILLS_DIR;
  const home = homedir();
  if (host) {
    const rel = HOST_DIRS[host.toLowerCase()];
    if (!rel) fail(`未知 --host: ${host}（可用: ${Object.keys(HOST_DIRS).join(', ')}）`);
    return join(home, ...rel.split('/'));
  }
  // No explicit target: DO NOT guess a host. List options and stop, so a
  // universal skill never lands under the wrong Agent (e.g. defaulting to Kiro).
  const existing = Object.entries(HOST_DIRS)
    .filter(([, rel]) => existsSync(join(home, rel.split('/')[0])))
    .map(([name]) => name);
  fail(
    '请指定要装到哪个 Agent 的 skills 目录（不同 Agent 目录不同，无法自动判断你在用哪个）：\n' +
    '  Copilot CLI : node install.mjs --host copilot\n' +
    '  Kiro        : node install.mjs --host kiro\n' +
    '  Claude      : node install.mjs --host claude\n' +
    '  通用 .agents: node install.mjs --host agents\n' +
    '  自定义目录  : node install.mjs --dest <目录>' +
    (existing.length ? `\n（本机已存在这些 Agent 目录：${existing.join(', ')}）` : ''),
  );
}

function installOne(name, destDir) {
  const src = join(SKILLS_SRC, name);
  if (!existsSync(src)) { console.error(`找不到 Skill 源目录: ${src}`); process.exit(1); }
  mkdirSync(destDir, { recursive: true });
  cpSync(src, join(destDir, name), { recursive: true });
  console.log(`  ✓ 已安装 ${name} → ${join(destDir, name)}`);
}

const args = parseArgs(process.argv);
const target = SKILL_MAP[args.skill];
if (!target && args.skill !== 'both' && args.skill !== 'all') {
  console.error(`未知 --skill 取值: ${args.skill}（可用: universal | service | both）`);
  process.exit(2);
}

const destDir = resolveDest(args.dest, args.host);
console.log('Skill 安装');
console.log(`  源:   ${SKILLS_SRC}`);
console.log(`  目标: ${destDir}\n`);

if (args.skill === 'both' || args.skill === 'all') {
  installOne('kone-expense-reimbursement', destDir);
  installOne('rebu-expense-agent', destDir);
} else {
  installOne(target, destDir);
}

console.log('\n重启或刷新你的 Agent 宿主后即可发现该 Skill。');
if (String(args.host).toLowerCase() === 'copilot' || /(?:^|\/)\.copilot\//.test(destDir)) {
  console.log('Copilot CLI：在会话里执行 /skills reload，再用 /skills info kone-expense-reimbursement 确认。');
}
if (target === 'rebu-expense-agent' || args.skill === 'both' || args.skill === 'all') {
  console.log('服务型 Skill 还需按 README「类别一」配置 rebu MCP。');
}
