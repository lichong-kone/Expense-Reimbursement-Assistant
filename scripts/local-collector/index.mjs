#!/usr/bin/env node
/**
 * Local Self-contained Expense Collector — Orchestrator
 *
 * End-to-end local pipeline: inbox filling → extraction → policy review → formal Excel.
 * Does not depend on Web UI, database, or REBU server.
 *
 * Usage:
 *   node scripts/local-collector/index.mjs [--config sources.json] [--once|--watch <seconds>]
 *   node scripts/local-collector/index.mjs --help
 *
 * See docs/spec/REBU_SYSTEM_SPEC.md §6.8.6.10
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveConfig } from './lib/config.mjs';
import { fillMailbox, precheckMailbox } from './lib/mailbox-filler.mjs';
import { extractNewFiles } from './lib/extractor.mjs';
import { scanInbox, assembleInput } from './lib/inbox-scanner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SKILL_DIR = resolve(REPO_ROOT, 'skills', 'kone-expense-reimbursement');
const PORTABLE_CORE = join(SKILL_DIR, 'portable-core.mjs');
const BUNDLE_MJS = join(SKILL_DIR, 'template-adapter', 'bundle.mjs');

// ─── CLI Parsing ─────────────────────────────────────────────────────

function printHelp() {
  console.log(`
本地自包含报销采集器 — 编排器

用法:
  node scripts/local-collector/index.mjs [options]

选项:
  --config <path>    sources.json 配置路径 (默认: ./sources.json)
  --once             单次执行 (默认)
  --watch <秒>       轮询模式，每 N 秒执行一次
  --precheck         仅做邮箱网络连通性预检 (不下载、不处理)
  --help, -h         显示帮助

环境变量:
  配置中 mailbox.passwordEnv 指定的变量名 (如 REBU_IMAP_PASS)

示例:
  # 首次配置（生成 sources.json）
  node scripts/local-collector/setup.mjs --mode mailbox --provider qq --help

  # 网络预检（公司网络常拦截出站 993，先验证）
  node scripts/local-collector/index.mjs --config ./sources.json --precheck

  # 单次执行
  node scripts/local-collector/index.mjs --config ./my-sources.json

  # 轮询模式（每 300 秒）
  node scripts/local-collector/index.mjs --config ./sources.json --watch 300
`.trim());
}

function parseArgs(argv) {
  const args = { config: './sources.json', watch: 0, help: false, precheck: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') { args.config = argv[++i]; }
    else if (a === '--once') { args.watch = 0; }
    else if (a === '--watch') { args.watch = parseInt(argv[++i], 10) || 60; }
    else if (a === '--precheck') { args.precheck = true; }
    else if (a === '--help' || a === '-h') { args.help = true; }
    else { console.error(`未知参数: ${a}`); process.exit(1); }
  }
  return args;
}

// ─── Pipeline ────────────────────────────────────────────────────────

function runPortableCore(inputPath, outputDir, statePath) {
  const args = ['--input', inputPath, '--output-dir', outputDir];
  if (statePath && existsSync(statePath)) {
    args.push('--state', statePath);
  } else if (statePath) {
    // Create empty state so portable-core can write to it
    writeFileSync(statePath, '{}', 'utf-8');
    args.push('--state', statePath);
  }

  console.log(`\n▶ portable-core.mjs ${args.join(' ')}`);
  try {
    const result = execFileSync(process.execPath, [PORTABLE_CORE, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SKILL_DIR,
    });
    if (result) console.log(result);
    return true;
  } catch (e) {
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
    console.error(`✗ portable-core.mjs 失败 (exit: ${e.status})`);
    return false;
  }
}

function runBundle(templateInputPath, outputDir) {
  const bundleDir = join(outputDir, 'bundle');
  mkdirSync(bundleDir, { recursive: true });

  const args = [
    BUNDLE_MJS,
    '--template-input', templateInputPath,
    '--output-dir', bundleDir,
    '--repo-root', REPO_ROOT,
  ];

  console.log(`\n▶ bundle.mjs --template-input ... --output-dir ${bundleDir}`);
  try {
    const result = execFileSync(process.execPath, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SKILL_DIR,
    });
    if (result) console.log(result);
    return true;
  } catch (e) {
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
    console.error(`✗ bundle.mjs 失败 (exit: ${e.status})`);
    return false;
  }
}

async function runPipeline(cfg) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 本地自包含报销采集器');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  mode:    ${cfg.mode}`);
  console.log(`  inbox:   ${cfg.inboxDir}`);
  console.log(`  output:  ${cfg.outputDir}`);
  console.log(`  state:   ${cfg.statePath}`);
  console.log(`  excel:   ${cfg.excel}`);
  console.log('');

  // Ensure directories exist
  mkdirSync(cfg.inboxDir, { recursive: true });
  mkdirSync(cfg.outputDir, { recursive: true });

  // Step 1: Mailbox filling (if mode = mailbox | both)
  if (cfg.mode === 'mailbox' || cfg.mode === 'both') {
    console.log('▶ [1/5] Mailbox 网络预检...');
    const pre = await precheckMailbox(cfg);
    if (!pre.ok) {
      console.error(`  ✗ 预检失败 [${pre.stage}/${pre.code}]: ${pre.hint}`);
      if (cfg.mode === 'mailbox') {
        console.error('  mode=mailbox 且网络预检失败，终止。请解决网络/凭据后重试（可先跑 --precheck）。');
        return false;
      }
      console.warn('  mode=both：本次跳过邮箱，仅处理本地 inbox。');
    } else {
      console.log(`  ✓ 预检通过（可见 ${pre.mailboxCount ?? '?'} 个文件夹），开始拉取...`);
      try {
        const downloaded = await fillMailbox(cfg);
        console.log(`  下载了 ${downloaded} 个新附件到 inbox`);
      } catch (err) {
        console.error(`  ⚠ Mailbox 填充失败: ${err.message}`);
        if (cfg.mode === 'mailbox') {
          console.error('  mode=mailbox 且填充失败，终止。');
          return false;
        }
        // mode=both: continue with local files
      }
    }
  } else {
    console.log('▶ [1/5] 跳过 Mailbox（mode=local）');
  }

  // Step 2: Extract new files
  console.log('\n▶ [2/5] 提取新文件...');
  const extractedCount = await extractNewFiles(cfg.inboxDir, cfg.statePath);
  console.log(`  提取了 ${extractedCount} 个新文件`);

  // Step 3: Scan inbox for processed items
  console.log('\n▶ [3/5] 扫描 inbox 已提取条目...');
  const invoiceItems = scanInbox(cfg.inboxDir);
  if (invoiceItems.length === 0) {
    console.log('  inbox 为空或无新发票，本次无需处理。');
    return true;
  }
  console.log(`  发现 ${invoiceItems.length} 个发票条目`);

  // Step 4: Assemble input and run portable-core
  console.log('\n▶ [4/5] 组装输入并执行政策审核...');
  const input = assembleInput(invoiceItems, cfg.employee, cfg.trip);
  const assembledPath = join(cfg.outputDir, '.assembled-input.json');
  writeFileSync(assembledPath, JSON.stringify(input, null, 2), 'utf-8');

  const success = runPortableCore(assembledPath, cfg.outputDir, cfg.statePath);
  if (!success) return false;

  // Step 5: Check for pending items, then optionally generate Excel
  const reviewQPath = join(cfg.outputDir, 'review-questions.json');
  let hasPending = false;
  if (existsSync(reviewQPath)) {
    try {
      const questions = JSON.parse(readFileSync(reviewQPath, 'utf-8'));
      if (Array.isArray(questions) && questions.length > 0) {
        hasPending = true;
        console.log(`\n⚠ 有 ${questions.length} 个待决项需要处理。`);
        console.log('  请编辑 review-decisions.template.json 后重跑 portable-core。');
      }
    } catch { /* ignore parse errors */ }
  }

  if (!hasPending && cfg.excel) {
    console.log('\n▶ [5/5] 生成正式 Excel...');
    const templateInputPath = join(cfg.outputDir, 'template-input.json');
    if (existsSync(templateInputPath)) {
      runBundle(templateInputPath, cfg.outputDir);
    } else {
      console.log('  template-input.json 不存在，跳过 Excel 生成。');
    }
  } else if (hasPending) {
    console.log('\n▶ [5/5] 跳过 Excel 生成（有待决项）');
  } else {
    console.log('\n▶ [5/5] 跳过 Excel 生成（excel=false）');
  }

  console.log('\n✓ 管线完成。');
  return true;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  const rawConfig = loadConfig(resolve(args.config));
  const cfg = resolveConfig(rawConfig, dirname(resolve(args.config)));

  if (args.precheck) {
    if (cfg.mode === 'local') {
      console.log('mode=local，无需邮箱网络预检。');
      process.exit(0);
    }
    console.log('▶ 邮箱网络预检...');
    const pre = await precheckMailbox(cfg);
    if (pre.ok) {
      console.log(`✓ 预检通过（可见 ${pre.mailboxCount ?? '?'} 个文件夹）。可以运行采集器了。`);
      process.exit(0);
    } else {
      console.error(`✗ 预检失败 [${pre.stage}/${pre.code}]: ${pre.hint}`);
      process.exit(1);
    }
  }

  if (args.watch > 0) {
    console.log(`轮询模式：每 ${args.watch} 秒执行一次 (Ctrl+C 退出)\n`);
    while (true) {
      await runPipeline(cfg);
      console.log(`\n⏳ 等待 ${args.watch} 秒...\n`);
      await new Promise(r => setTimeout(r, args.watch * 1000));
    }
  } else {
    const ok = await runPipeline(cfg);
    process.exit(ok ? 0 : 1);
  }
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
