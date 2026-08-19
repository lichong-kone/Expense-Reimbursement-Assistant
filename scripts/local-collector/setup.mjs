#!/usr/bin/env node
/**
 * setup.mjs — Guided onboarding / config persistence for the local collector.
 *
 * Purpose (Spec §6.8.6.12):
 *   Let the host Agent (or a user) configure the collector via a FIXED script
 *   instead of hand-writing sources.json or having the Agent improvise scripts.
 *
 * Two modes:
 *   - Interactive (TTY + no sufficient flags): readline prompts.
 *   - Non-interactive (Agent): pass all fields as flags, optionally --print to
 *     preview the resulting JSON without writing.
 *
 * Credential safety:
 *   - NEVER writes a password/auth-code. Only records mailbox.passwordEnv (the
 *     name of an environment variable). --show redacts sensitive fields.
 *
 * Usage:
 *   node scripts/local-collector/setup.mjs --mode local --inbox ./inbox
 *   node scripts/local-collector/setup.mjs --mode mailbox --provider qq \
 *     --name 张三 --employee-id K123 --level staff \
 *     --mailbox-user me@qq.com --password-env REBU_IMAP_PASS [--print]
 *   node scripts/local-collector/setup.mjs --show [--workdir .]
 *   node scripts/local-collector/setup.mjs --help
 *
 * See docs/spec/REBU_SYSTEM_SPEC.md §6.8.6.12
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ─── Provider presets (aligned with src/server/mail/account.service.ts) ──────

export const PROVIDER_PRESETS = {
  gmail:   { host: 'imap.gmail.com',        port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true },
  qq:      { host: 'imap.qq.com',           port: 993, secure: true },
  '163':   { host: 'imap.163.com',          port: 993, secure: true },
  '126':   { host: 'imap.126.com',          port: 993, secure: true },
  yeah:    { host: 'imap.yeah.net',         port: 993, secure: true },
};

const VALID_MODES = ['local', 'mailbox', 'both'];
const VALID_LEVELS = ['staff', 'manager', 'assistant_director', 'director', 'evp'];

// ─── Pure builder (testable) ─────────────────────────────────────────────────

/**
 * Build { sources, employee } config objects from collected answers.
 * Does not touch the filesystem. Never includes secret values.
 *
 * @param {object} a - answers
 * @returns {{ sources: object, employee: object }}
 */
export function buildConfig(a) {
  const mode = a.mode || 'local';
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`无效的 mode: "${mode}"，允许值: ${VALID_MODES.join(', ')}`);
  }

  const level = a.level || 'staff';
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`无效的 level: "${level}"，允许值: ${VALID_LEVELS.join(', ')}`);
  }

  const employee = {
    name: a.name || '待填写',
    employeeId: a.employeeId || '',
    department: a.department || '',
    position: a.position || '',
    costCenter: a.costCenter || '',
    level,
  };

  const sources = {
    version: '1.0.0',
    mode,
    inboxDir: a.inbox || './inbox',
    outputDir: a.output || './output',
    statePath: a.state || './state.json',
    schedule: a.schedule || 'manual',
    employeeFile: a.employeeFile || './employee.json',
    excel: a.excel !== false,
  };

  if (a.trip && (a.tripStart || a.tripEnd || a.destination || a.purpose)) {
    sources.trip = {
      startDate: a.tripStart || '',
      endDate: a.tripEnd || '',
      destination: a.destination || '',
      purpose: a.purpose || '',
    };
  }

  if (mode === 'mailbox' || mode === 'both') {
    let host = a.mailboxHost;
    let port = a.mailboxPort;
    let secure = a.mailboxSecure;
    const preset = a.provider ? PROVIDER_PRESETS[a.provider] : null;
    if (preset) {
      host = host || preset.host;
      port = port || preset.port;
      secure = secure === undefined ? preset.secure : secure;
    }
    sources.mailbox = {
      provider: a.provider || 'custom',
      host: host || '',
      port: port || 993,
      secure: secure === undefined ? true : secure,
      user: a.mailboxUser || '',
      passwordEnv: a.passwordEnv || 'REBU_IMAP_PASS',
      folder: a.mailboxFolder || 'INBOX',
      subjectFilter: a.subjectFilter || '',
      sinceDays: a.sinceDays || 30,
    };
  }

  return { sources, employee };
}

/**
 * Return a redacted copy of a sources config safe for display/logging.
 * (No secret is ever stored, but we defensively strip any stray fields.)
 */
export function redactSources(sources) {
  const clone = JSON.parse(JSON.stringify(sources || {}));
  if (clone.mailbox) {
    for (const k of ['password', 'pass', 'authCode', 'auth_code']) {
      if (k in clone.mailbox) clone.mailbox[k] = '***';
    }
  }
  return clone;
}

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
setup.mjs — 本地采集器引导式配置 (Spec §6.8.6.12)

用法:
  node scripts/local-collector/setup.mjs [options]

通用:
  --workdir <path>       写入目录 (默认: 当前目录)
  --print, --dry-run     只打印将写入的 JSON，不落盘 (Agent 预览用)
  --show                 显示 workdir 下现有配置 (敏感字段脱敏)
  --help, -h             显示帮助

数据源:
  --mode local|mailbox|both   数据源模式 (默认 local)
  --inbox <path>              inbox 文件夹 (默认 ./inbox)
  --output <path>             输出目录 (默认 ./output)
  --state <path>              状态文件 (默认 ./state.json)
  --schedule manual|daily|every_12h
  --no-excel                  不自动生成正式 Excel

员工基础信息 (会保存到 employee.json, 复用):
  --name --employee-id --department --position --cost-center
  --level staff|manager|assistant_director|director|evp

邮箱 (mode=mailbox|both):
  --provider qq|163|126|gmail|outlook|yeah   自动填充 host/port/secure
  --mailbox-host --mailbox-port --mailbox-user --mailbox-folder
  --since-days <n>            首次回溯天数 (默认 30)
  --subject-filter <regex>    主题过滤正则 (可选)
  --password-env <VAR>        IMAP 密码/授权码的环境变量名 (默认 REBU_IMAP_PASS)
                              ⚠ 密码本身绝不写入配置，只通过环境变量提供

示例 (Agent 非交互):
  node scripts/local-collector/setup.mjs --mode mailbox --provider qq \\
    --name 张三 --employee-id K12345 --department IT --level staff \\
    --mailbox-user zhangsan@qq.com --password-env REBU_IMAP_PASS --print
`.trim());
}

function parseArgs(argv) {
  const a = { workdir: '.', print: false, show: false, help: false, trip: false };
  const map = {
    '--workdir': 'workdir', '--mode': 'mode', '--inbox': 'inbox', '--output': 'output',
    '--state': 'state', '--schedule': 'schedule', '--name': 'name',
    '--employee-id': 'employeeId', '--department': 'department', '--position': 'position',
    '--cost-center': 'costCenter', '--level': 'level', '--provider': 'provider',
    '--mailbox-host': 'mailboxHost', '--mailbox-port': 'mailboxPort',
    '--mailbox-user': 'mailboxUser', '--mailbox-folder': 'mailboxFolder',
    '--since-days': 'sinceDays', '--subject-filter': 'subjectFilter',
    '--password-env': 'passwordEnv', '--trip-start': 'tripStart', '--trip-end': 'tripEnd',
    '--destination': 'destination', '--purpose': 'purpose',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { a.help = true; }
    else if (arg === '--print' || arg === '--dry-run') { a.print = true; }
    else if (arg === '--show') { a.show = true; }
    else if (arg === '--no-excel') { a.excel = false; }
    else if (arg in map) {
      const key = map[arg];
      let val = argv[++i];
      if (key === 'mailboxPort' || key === 'sinceDays') val = parseInt(val, 10);
      if (key === 'tripStart' || key === 'tripEnd' || key === 'destination' || key === 'purpose') a.trip = true;
      a[key] = val;
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }
  return a;
}

/** Do the provided flags carry enough to skip interactive prompts? */
function hasSufficientFlags(a) {
  if (!a.mode) return false;
  if (a.mode === 'mailbox' || a.mode === 'both') {
    // Need at least a provider (or host) and a user to configure mailbox
    return !!(a.provider || a.mailboxHost) && !!a.mailboxUser;
  }
  return true; // local mode only needs mode
}

// ─── Interactive prompts ──────────────────────────────────────────────────────

async function runInteractive(a) {
  const rl = createInterface({ input, output });
  const ask = async (q, def) => {
    const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
    const ans = (await rl.question(`${q}${suffix}: `)).trim();
    return ans || def || '';
  };

  try {
    console.log('\n=== 报销采集器 · 首次配置 ===\n');

    // 1. Data source
    let mode = a.mode;
    if (!mode) {
      console.log('发票从哪来？');
      console.log('  1) 本地文件夹（我把发票放进去）');
      console.log('  2) 邮箱自动收取');
      console.log('  3) 两者都要');
      const choice = await ask('选择 1/2/3', '1');
      mode = choice === '2' ? 'mailbox' : choice === '3' ? 'both' : 'local';
    }
    a.mode = mode;

    // 2. Paths
    a.inbox = a.inbox || await ask('inbox 文件夹路径', './inbox');
    a.output = a.output || await ask('output 输出目录', './output');

    // 3. Employee info
    console.log('\n--- 员工基础信息（会保存下来，下次自动复用）---');
    a.name = a.name || await ask('姓名', '');
    a.employeeId = a.employeeId || await ask('工号', '');
    a.department = a.department || await ask('部门', '');
    a.position = a.position || await ask('职位', '');
    a.costCenter = a.costCenter || await ask('成本中心号', '');
    a.level = a.level || await ask(`员工级别 (${VALID_LEVELS.join('/')})`, 'staff');

    // 4. Mailbox
    if (mode === 'mailbox' || mode === 'both') {
      console.log('\n--- 邮箱设置 ---');
      a.provider = a.provider || await ask('服务商 (qq/163/126/gmail/outlook/yeah, 自定义留空)', '');
      if (!a.provider || !PROVIDER_PRESETS[a.provider]) {
        a.mailboxHost = a.mailboxHost || await ask('IMAP 服务器 host', '');
        a.mailboxPort = a.mailboxPort || parseInt(await ask('IMAP 端口', '993'), 10);
      }
      a.mailboxUser = a.mailboxUser || await ask('邮箱账号', '');
      a.mailboxFolder = a.mailboxFolder || await ask('IMAP 文件夹', 'INBOX');
      a.sinceDays = a.sinceDays || parseInt(await ask('首次回溯天数', '30'), 10);
      a.passwordEnv = a.passwordEnv || await ask('密码/授权码的环境变量名', 'REBU_IMAP_PASS');
      console.log(`\n⚠ 密码不会写入配置。请设置环境变量：export ${a.passwordEnv}="你的IMAP授权码"`);
    }

    return a;
  } finally {
    rl.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let a = parseArgs(process.argv);
  if (a.help) { printHelp(); process.exit(0); }

  const workdir = resolve(a.workdir || '.');
  const sourcesPath = join(workdir, 'sources.json');
  const employeePath = join(workdir, 'employee.json');

  // --show: display current config redacted
  if (a.show) {
    if (!existsSync(sourcesPath)) {
      console.log(`未找到配置: ${sourcesPath}（尚未运行 setup）`);
      process.exit(0);
    }
    const sources = JSON.parse(readFileSync(sourcesPath, 'utf-8'));
    console.log('sources.json:');
    console.log(JSON.stringify(redactSources(sources), null, 2));
    if (existsSync(employeePath)) {
      console.log('\nemployee.json:');
      console.log(readFileSync(employeePath, 'utf-8'));
    }
    if (sources.mailbox?.passwordEnv) {
      const isSet = !!process.env[sources.mailbox.passwordEnv];
      console.log(`\n凭据环境变量 ${sources.mailbox.passwordEnv}: ${isSet ? '已设置 ✓' : '未设置 ✗'}`);
    }
    process.exit(0);
  }

  // Interactive vs non-interactive
  const interactive = input.isTTY && !hasSufficientFlags(a);
  if (interactive) {
    a = await runInteractive(a);
  } else if (!a.mode) {
    a.mode = 'local';
  }

  let built;
  try {
    built = buildConfig(a);
  } catch (err) {
    console.error(`配置错误: ${err.message}`);
    process.exit(1);
  }

  const { sources, employee } = built;

  if (a.print) {
    console.log('# sources.json (预览，未写入)');
    console.log(JSON.stringify(redactSources(sources), null, 2));
    console.log('\n# employee.json (预览，未写入)');
    console.log(JSON.stringify(employee, null, 2));
    process.exit(0);
  }

  writeFileSync(employeePath, JSON.stringify(employee, null, 2), 'utf-8');
  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2), 'utf-8');

  console.log(`✓ 已写入配置：`);
  console.log(`  ${sourcesPath}`);
  console.log(`  ${employeePath}`);

  console.log('\n下一步：');
  if (sources.mode === 'mailbox' || sources.mode === 'both') {
    const env = sources.mailbox?.passwordEnv || 'REBU_IMAP_PASS';
    if (!process.env[env]) {
      console.log(`  1) 设置邮箱凭据环境变量： export ${env}="你的IMAP授权码"`);
    }
    console.log(`  2) 网络预检： node scripts/local-collector/index.mjs --config ${sourcesPath} --precheck`);
    console.log(`  3) 运行采集： node scripts/local-collector/index.mjs --config ${sourcesPath} --once`);
  } else {
    console.log(`  1) 把发票文件放入 ${sources.inboxDir}`);
    console.log(`  2) 运行采集： node scripts/local-collector/index.mjs --config ${sourcesPath} --once`);
  }
}

// Only run when invoked directly (CLI), not when imported (e.g. by tests).
import { pathToFileURL } from 'node:url';
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('致命错误:', err);
    process.exit(1);
  });
}