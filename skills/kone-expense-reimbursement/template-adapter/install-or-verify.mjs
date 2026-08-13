#!/usr/bin/env node
/**
 * Install & Verify — One-shot integrity check for the Controlled Bundle.
 *
 * Verifies:
 *   1. Policy pack (resources/policy-rules.json) exists and is parseable
 *   2. Template pack: official .xlsx exists at controlled path and SHA-256 matches
 *   3. Mapping version consistency between adapter modules
 *   4. All adapter source files present
 *   5. portable-core.mjs exists
 *
 * Usage:
 *   node install-or-verify.mjs [--repo-root <path>]
 *   node install-or-verify.mjs --install   (same checks; reserved for future setup actions)
 *   node install-or-verify.mjs --verify-bundle
 *
 * Exit 0 = all checks pass; Exit 1 = failure (never silently degrades).
 *
 * CONTROLLED INTERNAL USE ONLY — do not distribute outside the organization.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Skill root: one level up from template-adapter/
const SKILL_ROOT = resolve(__dirname, '..');
const DEFAULT_REPO_ROOT = resolve(SKILL_ROOT, '..', '..', '..');

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = DEFAULT_REPO_ROOT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo-root' && args[i + 1]) {
      repoRoot = resolve(args[++i]);
    }
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  KONE Expense Reimbursement — Bundle Integrity Check');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Skill root : ${SKILL_ROOT}`);
  console.log(`  Repo root  : ${repoRoot}`);
  console.log('');

  const errors = [];
  const checks = [];

  // ── 1. Policy pack ──
  const policyPath = join(SKILL_ROOT, 'resources', 'policy-rules.json');
  if (!existsSync(policyPath)) {
    errors.push('Policy pack missing: resources/policy-rules.json');
    checks.push({ name: 'Policy pack', status: 'FAIL', detail: 'File not found' });
  } else {
    try {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
      if (!policy.version) throw new Error('Missing version field');
      checks.push({ name: 'Policy pack', status: 'OK', detail: `v${policy.version}` });
    } catch (e) {
      errors.push(`Policy pack invalid: ${e.message}`);
      checks.push({ name: 'Policy pack', status: 'FAIL', detail: e.message });
    }
  }

  // ── 2. Portable core ──
  const corePath = join(SKILL_ROOT, 'portable-core.mjs');
  if (!existsSync(corePath)) {
    errors.push('portable-core.mjs not found');
    checks.push({ name: 'Portable core', status: 'FAIL', detail: 'File not found' });
  } else {
    checks.push({ name: 'Portable core', status: 'OK', detail: 'present' });
  }

  // ── 3. Template adapter files ──
  const adapterFiles = [
    'template-adapter/cell-mapping.mjs',
    'template-adapter/template-pack.mjs',
    'template-adapter/renderer.mjs',
    'template-adapter/bundle.mjs',
  ];
  for (const f of adapterFiles) {
    const p = join(SKILL_ROOT, f);
    if (!existsSync(p)) {
      errors.push(`Adapter file missing: ${f}`);
      checks.push({ name: `Adapter: ${f}`, status: 'FAIL', detail: 'File not found' });
    } else {
      checks.push({ name: `Adapter: ${f}`, status: 'OK', detail: 'present' });
    }
  }

  // ── 4. Official template ──
  const { resolveTemplate, CONTROLLED_TEMPLATES } = await import('./template-pack.mjs');
  const { MAPPING_VERSION: cellMappingVer } = await import('./cell-mapping.mjs');
  const resolved = resolveTemplate(repoRoot);
  const templateFullPath = resolved ? resolved.path : null;
  if (!templateFullPath || !existsSync(templateFullPath)) {
    errors.push('Official template missing: skill-local official-template/ or docs/templates/1.报销申请_template.xlsx');
    checks.push({ name: 'Official template', status: 'FAIL', detail: 'File not found' });
  } else {
    // Verify SHA-256
    const data = readFileSync(templateFullPath);
    const hash = createHash('sha256').update(data).digest('hex');

    const entry = CONTROLLED_TEMPLATES.find(t => t.sha256 === hash);
    if (!entry) {
      errors.push(`Template SHA-256 mismatch. Got: ${hash}. Not in controlled registry.`);
      checks.push({ name: 'Official template hash', status: 'FAIL', detail: `SHA-256: ${hash}` });
    } else {
      checks.push({ name: 'Official template hash', status: 'OK', detail: `SHA-256 verified` });

      // ── 5. Mapping version consistency ──
      if (entry.mappingVersion !== cellMappingVer) {
        errors.push(`Mapping version inconsistency: registry=${entry.mappingVersion}, cell-mapping=${cellMappingVer}`);
        checks.push({ name: 'Mapping version', status: 'FAIL', detail: 'Inconsistent' });
      } else {
        checks.push({ name: 'Mapping version', status: 'OK', detail: `v${cellMappingVer}` });
      }
    }
  }

  // ── Report ──
  console.log('  Check Results:');
  for (const c of checks) {
    const icon = c.status === 'OK' ? '✓' : '✗';
    console.log(`    ${icon} ${c.name}: ${c.detail}`);
  }
  console.log('');

  if (errors.length > 0) {
    console.error('  ✗ BUNDLE INTEGRITY CHECK FAILED');
    console.error('');
    for (const e of errors) {
      console.error(`    - ${e}`);
    }
    console.error('');
    console.error('  The bundle cannot be used until all issues are resolved.');
    console.error('  Do NOT silently degrade — fix the configuration.');
    process.exit(1);
  }

  console.log('  ✓ ALL CHECKS PASSED — Bundle is ready for use.');
  console.log('');
  console.log('  To generate a controlled Excel:');
  console.log('    1. Run portable-core.mjs to produce template-input.json');
  console.log('    2. Run: node template-adapter/bundle.mjs --template-input ./output/template-input.json');
  console.log('');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
