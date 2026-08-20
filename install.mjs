#!/usr/bin/env node
/**
 * Skill 安装器（Node 版，跨平台：Windows / macOS / Linux 一条命令通用，只需 Node 18+）。
 *
 * 通用 Skill 必须装到你**实际使用的 Agent** 的 skills 目录，本安装器**不自动默认**任何一个：
 *   node install.mjs --host copilot    → ~/.copilot/skills   (GitHub Copilot CLI，也支持 ~/.agents/skills)
 *   node install.mjs --host kiro       → ~/.kiro/skills      (Kiro)
 *   node install.mjs --host claude     → ~/.claude/skills    (Claude)
 *   node install.mjs --host agents     → ~/.agents/skills    (通用 .agents)
 *   node install.mjs --dest <目录>     → 任意自定义 skills 目录
 *   node install.mjs --skill service|both --host <agent>     选择要装的 Skill（默认 universal）
 *
 * 同一份脚本兼容两种仓库布局：根目录 install.mjs（skills/ 同级）或 scripts/install-skill.mjs（skills/ 在上一级）。
 */

import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-locate the skills/ source dir for either layout (repo-root or scripts/).
const SKILLS_SRC = existsSync(join(__dirname, 'skills'))
  ? join(__dirname, 'skills')
  : join(__dirname, '..', 'skills');
const REPO_ROOT = dirname(SKILLS_SRC);

const SKILL_MAP = {
  universal: 'kone-expense-reimbursement',
  portable: 'kone-expense-reimbursement',
  kone: 'kone-expense-reimbursement',
  'kone-expense-reimbursement': 'kone-expense-reimbursement',
  service: 'rebu-expense-agent',
  mcp: 'rebu-expense-agent',
  'rebu-expense-agent': 'rebu-expense-agent',
};

// Per-host personal skills directory, relative to $HOME (joined with the
// platform separator so Windows gets C:\Users\you\.copilot\skills etc.).
const HOST_DIRS = {
  copilot: ['.copilot', 'skills'],
  kiro: ['.kiro', 'skills'],
  claude: ['.claude', 'skills'],
  agents: ['.agents', 'skills'],
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
  console.log(`Skill 安装器（Node 版，Windows / macOS / Linux 通用）

选择你实际使用的 Agent（不同 Agent 的 skills 目录不同）：
  --host copilot    → ~/.copilot/skills   (GitHub Copilot CLI)
  --host kiro       → ~/.kiro/skills      (Kiro)
  --host claude     → ~/.claude/skills    (Claude)
  --host agents     → ~/.agents/skills    (通用 .agents)
  --dest <目录>     → 任意自定义 skills 目录

  --skill universal|service|both   选择要装的 Skill（默认 universal）`);
}

function fail(msg) { console.error(msg); process.exit(1); }

function resolveDest(dest, host) {
  if (dest) return dest;
  if (process.env.REBU_SKILLS_DIR) return process.env.REBU_SKILLS_DIR;
  const home = homedir();
  if (host) {
    const rel = HOST_DIRS[String(host).toLowerCase()];
    if (!rel) { console.error(`未知 --host: ${host}（可用: ${Object.keys(HOST_DIRS).join(', ')}）`); process.exit(2); }
    return join(home, ...rel);
  }
  // No explicit target: never guess a host (a universal skill must not land
  // under the wrong Agent). List the options and stop.
  fail(
    '请指定要装到哪个 Agent 的 skills 目录（不同 Agent 目录不同，不自动默认）：\n' +
    '  Copilot CLI : --host copilot\n' +
    '  Kiro        : --host kiro\n' +
    '  Claude      : --host claude\n' +
    '  通用 .agents: --host agents\n' +
    '  自定义目录  : --dest <目录>',
  );
}

function installOne(name, destDir) {
  const src = join(SKILLS_SRC, name);
  if (!existsSync(src)) fail(`找不到 Skill 源目录: ${src}`);
  mkdirSync(destDir, { recursive: true });
  cpSync(src, join(destDir, name), { recursive: true });
  console.log(`  ✓ 已安装 ${name} → ${join(destDir, name)}`);
}

const args = parseArgs(process.argv);
if (!SKILL_MAP[args.skill] && args.skill !== 'both' && args.skill !== 'all') {
  console.error(`未知 --skill 取值: ${args.skill}（可用: universal | service | both）`);
  process.exit(2);
}

const destDir = resolveDest(args.dest, args.host);
console.log('Skill 安装');
console.log(`  源:   ${SKILLS_SRC}`);
console.log(`  目标: ${destDir}\n`);

const installedUniversal = args.skill === 'both' || args.skill === 'all' || SKILL_MAP[args.skill] === 'kone-expense-reimbursement';
if (args.skill === 'both' || args.skill === 'all') {
  installOne('kone-expense-reimbursement', destDir);
  installOne('rebu-expense-agent', destDir);
} else {
  installOne(SKILL_MAP[args.skill], destDir);
}

console.log('\n重启或刷新你的 Agent 宿主后即可发现该 Skill。');
if (String(args.host).toLowerCase() === 'copilot' || destDir.includes('.copilot')) {
  console.log('Copilot CLI：在会话里执行 /skills reload，再用 /skills info kone-expense-reimbursement 确认。');
}
if (SKILL_MAP[args.skill] === 'rebu-expense-agent' || args.skill === 'both' || args.skill === 'all') {
  console.log('服务型 Skill 还需按 README「类别一」配置 rebu MCP。');
}

// Optional: verify the controlled bundle when the universal skill's verifier exists.
if (installedUniversal) {
  const verify = join(SKILLS_SRC, 'kone-expense-reimbursement', 'template-adapter', 'install-or-verify.mjs');
  if (existsSync(verify)) {
    console.log('\n（可选）生成正式 Excel 前，可在仓库内校验受控 Bundle：');
    console.log(`  node ${verify} --repo-root ${REPO_ROOT}`);
  }
}
