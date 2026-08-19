#!/usr/bin/env node
/**
 * collect.mjs — 本地数据源参考管线（Local Datasource Reference Pipeline）
 *
 * 功能：遍历 inbox 文件夹里"已提取为文本/JSON 的条目"，组装成 PortableSkillInput，
 * 调用 portable-core.mjs（带 --state 增量去重），产出审核包。
 *
 * 重要边界：
 * - PDF/OFD/XML/OCR 提取由宿主 agent 负责，本脚本不做二进制解析
 * - 零外部 npm 依赖，仅使用 Node.js 内置模块
 * - 不连接 REBU 服务器、不使用数据库、不需网络
 * - 不修改 src/server/**
 *
 * 约定：宿主 agent 或用户已把每张发票的文本放成 .json/.txt 文件在 inboxDir 中，
 * 或提供一个 manifest.json 列出条目。
 *
 * 用法：
 *   node scripts/collect.mjs [--config ./sources.json]
 *   node scripts/collect.mjs --inbox ./inbox --output ./output [--state ./state.json]
 *   node scripts/collect.mjs --help
 *
 * 参见 docs/spec/REBU_SYSTEM_SPEC.md §6.8.6
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, '..');
const SKILL_DIR = resolve(SCRIPT_DIR, '..');
const PORTABLE_CORE = join(SKILL_DIR, 'portable-core.mjs');

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
collect.mjs — 本地数据源参考管线

用法:
  node scripts/collect.mjs [options]

选项:
  --config <path>       sources.json 配置文件路径 (默认: ./sources.json)
  --inbox <path>        inbox 文件夹路径 (覆盖 config 中的 inboxDir)
  --output <path>       输出目录路径 (覆盖 config 中的 outputDir)
  --state <path>        增量状态文件路径 (默认: ./state.json)
  --employee <path>     员工信息 JSON 文件 (默认: ./employee.json)
  --trip <path>         行程信息 JSON 文件 (默认: ./trip.json)
  --dry-run             只扫描 inbox 并报告，不执行 portable-core
  --help, -h            显示帮助

示例:
  # 使用 sources.json 配置
  node scripts/collect.mjs --config ./sources.json

  # 直接指定路径
  node scripts/collect.mjs --inbox ./inbox --output ./output --state ./state.json

  # 仅扫描 inbox，不执行
  node scripts/collect.mjs --inbox ./inbox --dry-run

说明:
  本脚本假定 inbox 中的文件已经过宿主 agent 提取为文本/JSON。
  每个 .json 文件应符合 PortableSkillInput.invoices[*] 的单项结构：
    { "id": "...", "rawText": "...", "emailSubject": "...", "fileName": "..." }
  每个 .txt 文件内容视为 rawText。
  可选 manifest.json 列出所有条目。
  `.trimStart());
}

function parseArgs(argv) {
  const args = {
    config: './sources.json',
    inbox: null,
    output: null,
    state: './state.json',
    employee: './employee.json',
    trip: './trip.json',
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--config': args.config = argv[++i]; break;
      case '--inbox': args.inbox = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--state': args.state = argv[++i]; break;
      case '--employee': args.employee = argv[++i]; break;
      case '--trip': args.trip = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        console.error(`未知参数: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`无法解析配置文件 ${configPath}: ${e.message}`);
    process.exit(1);
  }
}

function resolveOptions(args) {
  const config = loadConfig(args.config);

  // CLI 参数覆盖 config
  const inboxDir = args.inbox || (config && config.inboxDir) || './inbox';
  const outputDir = args.output || (config && config.outputDir) || './output';
  const statePath = args.state || './state.json';

  return {
    inboxDir: resolve(inboxDir),
    outputDir: resolve(outputDir),
    statePath: resolve(statePath),
    employeePath: resolve(args.employee),
    tripPath: resolve(args.trip),
    dryRun: args.dryRun,
    config,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox Scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扫描 inbox 目录，收集已提取的发票条目。
 * 支持两种模式：
 * 1. 有 manifest.json → 按 manifest 列出条目
 * 2. 无 manifest → 扫描 .json 和 .txt 文件
 */
function scanInbox(inboxDir) {
  if (!existsSync(inboxDir)) {
    console.error(`inbox 目录不存在: ${inboxDir}`);
    console.error('请确保宿主 agent 已将提取后的发票文件放入 inbox 文件夹。');
    process.exit(1);
  }

  const manifestPath = join(inboxDir, 'manifest.json');

  if (existsSync(manifestPath)) {
    return scanFromManifest(manifestPath, inboxDir);
  }

  return scanFromFiles(inboxDir);
}

function scanFromManifest(manifestPath, inboxDir) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const items = [];

  if (!Array.isArray(manifest.items)) {
    console.error('manifest.json 需要包含 "items" 数组');
    process.exit(1);
  }

  for (const item of manifest.items) {
    // manifest item 可以直接包含 invoice 字段，或引用文件
    if (item.file) {
      const filePath = resolve(inboxDir, item.file);
      if (!existsSync(filePath)) {
        console.warn(`  [跳过] manifest 引用文件不存在: ${item.file}`);
        continue;
      }
      const parsed = readInvoiceFile(filePath);
      if (parsed) {
        // manifest 中的 metadata 可覆盖文件内字段
        items.push({ ...parsed, ...(item.metadata || {}) });
      }
    } else if (item.rawText || item.preParsed) {
      // 直接在 manifest 中内联数据
      items.push({
        id: item.id || `manifest_${items.length + 1}`,
        ...item,
      });
    }
  }

  return items;
}

function scanFromFiles(inboxDir) {
  const entries = readdirSync(inboxDir);
  const items = [];

  for (const entry of entries) {
    if (entry === 'manifest.json') continue;
    if (entry.startsWith('.')) continue; // 隐藏文件

    const filePath = join(inboxDir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) continue; // 不递归（约定一层）

    const ext = extname(entry).toLowerCase();
    if (ext !== '.json' && ext !== '.txt') {
      // 跳过非文本文件（PDF/OFD 等应由宿主提取后再放入）
      continue;
    }

    const parsed = readInvoiceFile(filePath);
    if (parsed) {
      items.push(parsed);
    }
  }

  return items;
}

/**
 * 读取单个发票文件，返回符合 PortableSkillInput.invoices[*] 的对象。
 */
function readInvoiceFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath, ext);

  try {
    const content = readFileSync(filePath, 'utf-8').trim();

    if (ext === '.json') {
      const obj = JSON.parse(content);
      // 确保有 id
      return { id: obj.id || name, fileName: basename(filePath), ...obj };
    }

    if (ext === '.txt') {
      // .txt 文件内容视为 rawText
      return {
        id: name,
        rawText: content,
        fileName: basename(filePath),
      };
    }
  } catch (e) {
    console.warn(`  [跳过] 无法读取 ${filePath}: ${e.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PortableSkillInput Assembly
// ─────────────────────────────────────────────────────────────────────────────

function loadEmployeeInfo(employeePath) {
  if (existsSync(employeePath)) {
    try {
      return JSON.parse(readFileSync(employeePath, 'utf-8'));
    } catch (e) {
      console.warn(`无法读取员工信息 ${employeePath}: ${e.message}，使用默认值`);
    }
  }

  // 默认骨架 — 用户应自行提供
  return {
    name: process.env.REBU_EMPLOYEE_NAME || '待填写',
    employeeId: process.env.REBU_EMPLOYEE_ID || '',
    department: process.env.REBU_DEPARTMENT || '',
    position: process.env.REBU_POSITION || '',
    costCenter: process.env.REBU_COST_CENTER || '',
    level: process.env.REBU_LEVEL || 'staff',
  };
}

function loadTripInfo(tripPath) {
  if (existsSync(tripPath)) {
    try {
      return JSON.parse(readFileSync(tripPath, 'utf-8'));
    } catch (e) {
      console.warn(`无法读取行程信息 ${tripPath}: ${e.message}，使用默认值`);
    }
  }
  // trip 是可选的
  return undefined;
}

function assembleInput(invoiceItems, employeePath, tripPath) {
  const employee = loadEmployeeInfo(employeePath);
  const trip = loadTripInfo(tripPath);

  const input = { employee, invoices: invoiceItems };
  if (trip) input.trip = trip;
  return input;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Execution
// ─────────────────────────────────────────────────────────────────────────────

function runPortableCore(inputPath, outputDir, statePath) {
  const args = ['--input', inputPath, '--output-dir', outputDir];
  if (statePath) {
    args.push('--state', statePath);
  }

  console.log(`\n▶ 执行: node portable-core.mjs ${args.join(' ')}`);
  try {
    const result = execFileSync(process.execPath, [PORTABLE_CORE, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SKILL_DIR,
    });
    if (result) console.log(result);
    return true;
  } catch (e) {
    // execFileSync throws on non-zero exit
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
    console.error(`\n✗ portable-core.mjs 执行失败 (exit code: ${e.status})`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const opts = resolveOptions(args);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' KONE 费用报销 — 本地数据源参考管线');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  inbox:   ${opts.inboxDir}`);
  console.log(`  output:  ${opts.outputDir}`);
  console.log(`  state:   ${opts.statePath}`);
  console.log(`  dry-run: ${opts.dryRun}`);
  console.log('');

  // 1. 扫描 inbox
  console.log('▶ 扫描 inbox...');
  const invoiceItems = scanInbox(opts.inboxDir);

  if (invoiceItems.length === 0) {
    console.log('  inbox 为空或没有可处理的 .json/.txt 文件。');
    console.log('  请确保宿主 agent 已将发票提取为文本/JSON 放入 inbox 目录。');
    process.exit(0);
  }

  console.log(`  发现 ${invoiceItems.length} 个条目:`);
  for (const item of invoiceItems) {
    const preview = (item.rawText || '').slice(0, 40).replace(/\n/g, ' ');
    console.log(`    - ${item.id}: ${item.fileName || '(inline)'} ${preview ? '| ' + preview + '...' : ''}`);
  }

  if (opts.dryRun) {
    console.log('\n[dry-run] 不执行 portable-core，仅报告 inbox 内容。');
    process.exit(0);
  }

  // 2. 组装 PortableSkillInput
  console.log('\n▶ 组装 PortableSkillInput...');
  const input = assembleInput(invoiceItems, opts.employeePath, opts.tripPath);

  // 写入临时输入文件
  mkdirSync(opts.outputDir, { recursive: true });
  const assembledInputPath = join(opts.outputDir, '.assembled-input.json');
  writeFileSync(assembledInputPath, JSON.stringify(input, null, 2), 'utf-8');
  console.log(`  已写入: ${assembledInputPath}`);

  // 3. 调用 portable-core.mjs
  const success = runPortableCore(assembledInputPath, opts.outputDir, opts.statePath);

  if (!success) {
    process.exit(1);
  }

  // 4. 检查待决项
  const reviewQuestionsPath = join(opts.outputDir, 'review-questions.json');
  if (existsSync(reviewQuestionsPath)) {
    try {
      const questions = JSON.parse(readFileSync(reviewQuestionsPath, 'utf-8'));
      if (Array.isArray(questions) && questions.length > 0) {
        console.log(`\n⚠  有 ${questions.length} 个待决项需要处理:`);
        for (const q of questions.slice(0, 5)) {
          console.log(`    - [${q.questionId || q.id}] ${q.summary || q.message || ''}`);
        }
        if (questions.length > 5) console.log(`    ... 及其他 ${questions.length - 5} 项`);
        console.log('\n  请编辑 review-decisions.template.json 后重跑:');
        console.log(`    node portable-core.mjs --input ${assembledInputPath} \\`);
        console.log(`      --decisions ${join(opts.outputDir, 'review-decisions.template.json')} \\`);
        console.log(`      --state ${opts.statePath} --output-dir ${opts.outputDir}`);
        process.exit(0);
      }
    } catch { /* 无 review-questions 或解析失败，继续 */ }
  }

  // 5. 无待决项时提示如何生成正式 Excel
  const templateInputPath = join(opts.outputDir, 'template-input.json');
  if (existsSync(templateInputPath)) {
    console.log('\n✓ 审核包已生成，无待决项。');
    console.log('');
    console.log('  如需生成正式 Excel（需已获授权的公司模板），执行:');
    console.log(`    node ${join(SKILL_DIR, 'template-adapter', 'bundle.mjs')} \\`);
    console.log(`      --template-input ${templateInputPath} \\`);
    console.log(`      --output-dir ${join(opts.outputDir, 'bundle')} \\`);
    console.log('      --repo-root <仓库根目录>');
  } else {
    console.log('\n✓ 执行完成。');
  }
}

main();
