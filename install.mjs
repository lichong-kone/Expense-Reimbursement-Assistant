#!/usr/bin/env node
/**
 * Expense Reimbursement Assistant — 跨平台 Skill 安装器（Node 版）
 *
 * 与 install.sh 等效，但 Windows / macOS / Linux 一条命令通用（只需 Node 18+）。
 *
 * 用法：
 *   node install.mjs                     # 装通用 Skill（kone-expense-reimbursement）
 *   node install.mjs --skill service     # 装服务型 Skill（rebu-expense-agent，需另配 MCP）
 *   node install.mjs --skill both        # 两个都装
 *   node install.mjs --dest <目录>       # 指定宿主 skills 目录
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

function parseArgs(argv) {
  const args = { skill: 'universal', dest: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skill') args.skill = argv[++i];
    else if (a === '--dest') args.dest = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`未知参数: ${a}（--help 查看用法）`); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`Skill 安装器（Node 版，跨平台）

  node install.mjs                   装通用 Skill（kone-expense-reimbursement）
  node install.mjs --skill service   装服务型 Skill（rebu-expense-agent，需另配 MCP）
  node install.mjs --skill both       两个都装
  node install.mjs --dest <目录>      指定宿主 skills 目录`);
}

function resolveDest(dest) {
  if (dest) return dest;
  if (process.env.REBU_SKILLS_DIR) return process.env.REBU_SKILLS_DIR;
  const home = homedir();
  if (existsSync(join(home, '.kiro'))) return join(home, '.kiro', 'skills');
  if (existsSync(join(home, '.agents'))) return join(home, '.agents', 'skills');
  // 都没有：默认落到 ~/.kiro/skills 并创建（避免报错卡住新用户）
  return join(home, '.kiro', 'skills');
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

const destDir = resolveDest(args.dest);
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
if (target === 'rebu-expense-agent' || args.skill === 'both' || args.skill === 'all') {
  console.log('服务型 Skill 还需按 README「类别一」配置 rebu MCP。');
}
