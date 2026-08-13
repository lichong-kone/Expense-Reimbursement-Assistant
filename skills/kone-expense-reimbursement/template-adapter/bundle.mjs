/**
 * Controlled Bundle Orchestrator
 *
 * Accepts template-input.json (from portable-core) + optional decision-log,
 * renders the formal Excel via the template adapter, and produces:
 *   - Formal Excel file(s) (submittable if fidelity passes)
 *   - Audit summary (fidelity verdict + submittability)
 *   - Decision log reference
 *   - Output manifest with all versions and hashes
 *
 * Usage:
 *   node bundle.mjs --template-input <path> [--output-dir <dir>] [--template-path <path>] [--repo-root <path>]
 *
 * CONTROLLED INTERNAL USE ONLY — do not distribute outside the organization.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderControlledExcel } from './renderer.mjs';
import { MAPPING_VERSION } from './cell-mapping.mjs';
import {
  TEMPLATE_PACK_VERSION,
  CONTROLLED_TEMPLATES,
  resolveTemplate,
  computeSha256,
  validateTemplateHash,
} from './template-pack.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default repo root: 4 levels up from template-adapter/
const DEFAULT_REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

// ─── Bundle Generation ───────────────────────────────────────────────

/**
 * Generate a controlled reimbursement bundle.
 *
 * @param {Object} options
 * @param {Object} options.templateInput - Parsed template-input.json content
 * @param {Object} [options.decisionLog] - Parsed decision-log.json content (optional)
 * @param {string} options.outputDir - Output directory for bundle files
 * @param {string} [options.templatePath] - Explicit template path (overrides resolution)
 * @param {string} [options.repoRoot] - Repository root for template resolution
 * @param {string} [options.policyPackVersion] - Policy pack version from portable-core run
 * @returns {Object} Bundle result
 */
export function generateBundle(options) {
  const {
    templateInput,
    decisionLog = null,
    outputDir,
    templatePath: explicitTemplatePath,
    repoRoot = DEFAULT_REPO_ROOT,
    policyPackVersion = 'unknown',
  } = options;

  // ── Resolve template ──
  let templatePath = explicitTemplatePath;
  if (!templatePath) {
    const resolved = resolveTemplate(repoRoot);
    if (!resolved) {
      return {
        success: false,
        error: 'Cannot resolve official template. Ensure docs/templates/1.报销申请_template.xlsx exists.',
        submittable: false,
      };
    }
    templatePath = resolved.path;
  }

  // ── Validate template ──
  const validation = validateTemplateHash(templatePath);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      submittable: false,
    };
  }

  // ── Validate template-input structure ──
  if (!templateInput || !templateInput.rows || !Array.isArray(templateInput.rows)) {
    return {
      success: false,
      error: 'Invalid template-input: missing or invalid "rows" array',
      submittable: false,
    };
  }

  // ── Render Excel ──
  mkdirSync(outputDir, { recursive: true });

  const renderResult = renderControlledExcel({
    templatePath,
    outputDir,
    data: {
      employee: templateInput.employee || {},
      rows: templateInput.rows,
    },
    filePrefix: '1.报销申请',
  });

  // ── Generate audit summary ──
  const auditSummary = generateAuditSummary({
    renderResult,
    templateInput,
    decisionLog,
    policyPackVersion,
  });

  const summaryPath = join(outputDir, 'bundle-summary.md');
  writeFileSync(summaryPath, auditSummary.markdown);

  // ── Generate manifest ──
  const manifest = generateManifest({
    renderResult,
    templateInput,
    policyPackVersion,
    outputDir,
    summaryPath,
  });

  const manifestPath = join(outputDir, 'bundle-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // ── Copy decision log reference if provided ──
  if (decisionLog) {
    const decisionLogPath = join(outputDir, 'decision-log.json');
    writeFileSync(decisionLogPath, JSON.stringify(decisionLog, null, 2));
  }

  return {
    success: renderResult.success,
    submittable: renderResult.success && renderResult.fidelityVerification.passed,
    files: renderResult.files,
    fidelityVerification: renderResult.fidelityVerification,
    manifestPath: relative(outputDir, manifestPath) || 'bundle-manifest.json',
    summaryPath: relative(outputDir, summaryPath) || 'bundle-summary.md',
    error: renderResult.error,
  };
}

// ─── Audit Summary ───────────────────────────────────────────────────

function generateAuditSummary({ renderResult, templateInput, decisionLog, policyPackVersion }) {
  const fv = renderResult.fidelityVerification;
  const submittable = renderResult.success && fv.passed;

  const lines = [
    '# 受控报销 Bundle 审核摘要',
    '',
    `**生成时间**: ${new Date().toISOString()}`,
    `**可递交**: ${submittable ? '✅ 是' : '❌ 否'}`,
    `**保真验证**: ${fv.passed ? '✅ 通过' : '❌ 未通过'}`,
    '',
    '## 版本信息',
    '',
    `| 项目 | 版本 |`,
    `| --- | --- |`,
    `| 政策包版本 | ${policyPackVersion} |`,
    `| 模板包版本 | ${TEMPLATE_PACK_VERSION} |`,
    `| 映射版本 | ${MAPPING_VERSION} |`,
    `| 官方模板 SHA-256 | \`${fv.templateSha256 || 'N/A'}\` |`,
    '',
    '## 保真验证详情',
    '',
  ];

  if (fv.passed) {
    lines.push('所有输出文件通过保真验证：');
    lines.push('- 仅授权单元格被修改');
    lines.push('- 关键 OOXML 部件（workbook.xml、styles.xml、sharedStrings.xml）字节不变');
    lines.push(`- 文件数量: ${fv.fileCount}`);
  } else {
    lines.push(`**验证失败原因**: ${fv.reason}`);
    lines.push('');
    lines.push('> ⚠️ 输出文件不可递交。请检查模板和映射版本一致性。');
  }

  lines.push('');
  lines.push('## 输出文件');
  lines.push('');

  if (renderResult.files && renderResult.files.length > 0) {
    for (const f of renderResult.files) {
      lines.push(`- **${f.name}** (${f.rowCount} 行) SHA-256: \`${f.sha256}\``);
    }
  } else {
    lines.push('（无输出文件）');
  }

  if (decisionLog) {
    lines.push('');
    lines.push('## 决定日志');
    lines.push('');
    lines.push(`已应用 ${decisionLog.decisions?.length || 0} 个决定。详见 decision-log.json。`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('> 本文件由受控报销 Bundle 自动生成。模板与映射仅限内部使用，不得公开分发。');

  return {
    markdown: lines.join('\n'),
    submittable,
  };
}

// ─── Output Manifest ─────────────────────────────────────────────────

function generateManifest({ renderResult, templateInput, policyPackVersion, outputDir, summaryPath }) {
  const fv = renderResult.fidelityVerification;

  const outputHashes = [];

  // Excel files
  if (renderResult.files) {
    for (const f of renderResult.files) {
      outputHashes.push({
        filePath: f.name,
        sha256: f.sha256,
      });
    }
  }

  // Summary
  outputHashes.push({
    filePath: 'bundle-summary.md',
    sha256: computeSha256(summaryPath),
  });

  return {
    policyPackVersion,
    templatePackVersion: TEMPLATE_PACK_VERSION,
    mappingVersion: MAPPING_VERSION,
    officialTemplateSha256: fv.templateSha256 || null,
    generatedAt: new Date().toISOString(),
    contractVersion: templateInput.contractVersion || null,
    fidelityVerification: {
      passed: fv.passed,
      reason: fv.reason,
    },
    outputHashes,
    submittable: renderResult.success && fv.passed,
  };
}

// ─── CLI Entry ───────────────────────────────────────────────────────

async function cli() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Controlled Bundle Generator (§6.8.5)

Usage:
  node bundle.mjs --template-input <path> [--output-dir <dir>] [--template-path <path>] [--repo-root <path>]

Options:
  --template-input   Path to template-input.json (from portable-core output)
  --decision-log     Path to decision-log.json (optional)
  --output-dir       Output directory (default: ./bundle-output)
  --template-path    Explicit path to official template (overrides auto-resolution)
  --repo-root        Repository root for template resolution (default: auto-detect)
  --policy-version   Policy pack version string
  --help, -h         Show this help

Output:
  1.报销申请-<name>[-N].xlsx    Formal Excel (submittable if fidelity passes)
  bundle-summary.md              Audit summary with fidelity verdict
  bundle-manifest.json           Versions, hashes, verification conclusion
  decision-log.json              Decision log (if provided)
`);
    return;
  }

  let templateInputPath = null;
  let decisionLogPath = null;
  let outputDir = './bundle-output';
  let templatePath = null;
  let repoRoot = DEFAULT_REPO_ROOT;
  let policyVersion = 'unknown';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--template-input' && args[i + 1]) templateInputPath = args[++i];
    else if (args[i] === '--decision-log' && args[i + 1]) decisionLogPath = args[++i];
    else if (args[i] === '--output-dir' && args[i + 1]) outputDir = args[++i];
    else if (args[i] === '--template-path' && args[i + 1]) templatePath = args[++i];
    else if (args[i] === '--repo-root' && args[i + 1]) repoRoot = args[++i];
    else if (args[i] === '--policy-version' && args[i + 1]) policyVersion = args[++i];
  }

  if (!templateInputPath) {
    console.error('Error: --template-input is required');
    process.exit(1);
  }

  if (!existsSync(templateInputPath)) {
    console.error(`Error: template-input file not found: ${templateInputPath}`);
    process.exit(1);
  }

  const templateInput = JSON.parse(readFileSync(templateInputPath, 'utf8'));

  let decisionLog = null;
  if (decisionLogPath && existsSync(decisionLogPath)) {
    decisionLog = JSON.parse(readFileSync(decisionLogPath, 'utf8'));
  }

  const result = generateBundle({
    templateInput,
    decisionLog,
    outputDir: resolve(outputDir),
    templatePath,
    repoRoot,
    policyPackVersion: policyVersion,
  });

  if (result.success) {
    console.log('✓ Bundle generated successfully');
    console.log(`  Submittable: ${result.submittable ? 'YES' : 'NO'}`);
    console.log(`  Files: ${result.files?.length || 0}`);
    console.log(`  Manifest: ${result.manifestPath}`);
    console.log(`  Summary: ${result.summaryPath}`);
  } else {
    console.error('✗ Bundle generation failed');
    console.error(`  Error: ${result.error}`);
    process.exit(1);
  }
}

// Run CLI if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('bundle.mjs') ||
  process.argv[1].includes('template-adapter/bundle')
);
if (isMain) {
  cli().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
