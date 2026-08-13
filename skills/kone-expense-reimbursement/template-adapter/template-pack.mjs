/**
 * Template Pack — Controlled template registry and integrity verification.
 *
 * The official template is stored at a controlled location (docs/templates/).
 * This module records the template's SHA-256, mapping version, and source path.
 * It NEVER embeds the template binary; it resolves the template at runtime.
 *
 * CONTROLLED INTERNAL USE ONLY — do not distribute outside the organization.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MAPPING_VERSION } from './cell-mapping.mjs';

/** Template pack version. Bump when template or mapping changes. */
export const TEMPLATE_PACK_VERSION = '1.0.0';

/**
 * Controlled template registry entry.
 * SHA-256 whitelist — only templates with a hash in this list are accepted.
 */
export const CONTROLLED_TEMPLATES = [
  {
    logicalName: '报销申请',
    templatePackVersion: TEMPLATE_PACK_VERSION,
    sha256: '1a489bc924cdb562f75f152505af00136a29f89468216603c6d5224ec6472b53',
    mappingVersion: MAPPING_VERSION,
    relativePath: 'docs/templates/1.报销申请_template.xlsx',
  },
];

/**
 * Resolve the official template file path.
 * Prefers the skill-local copy (template-adapter/official-template/), then
 * falls back to a repo-root relative path.
 * @param {string} [repoRoot] - Optional repository root for fallback resolution.
 * @returns {{ path: string, entry: object } | null}
 */
export function resolveTemplate(repoRoot) {
  const adapterDir = resolve(import.meta.url.replace('file://', ''), '..');
  const localPath = join(adapterDir, 'official-template', '报销申请_template.xlsx');
  if (existsSync(localPath)) {
    return { path: localPath, entry: CONTROLLED_TEMPLATES[0] };
  }
  const root = repoRoot || resolve(adapterDir, '..', '..', '..');
  for (const entry of CONTROLLED_TEMPLATES) {
    const fullPath = join(root, entry.relativePath);
    if (existsSync(fullPath)) {
      return { path: fullPath, entry };
    }
  }
  return null;
}

/**
 * Compute SHA-256 of a file buffer or path.
 * @param {Buffer | string} input - Buffer content or file path
 * @returns {string}
 */
export function computeSha256(input) {
  const data = Buffer.isBuffer(input) ? input : readFileSync(input);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Validate that a template file matches the controlled registry.
 * @param {string} templatePath - Absolute path to the template file
 * @returns {{ valid: boolean, entry?: object, error?: string }}
 */
export function validateTemplateHash(templatePath) {
  if (!existsSync(templatePath)) {
    return { valid: false, error: `Template file not found: ${templatePath}` };
  }
  const hash = computeSha256(templatePath);
  const entry = CONTROLLED_TEMPLATES.find(t => t.sha256 === hash);
  if (!entry) {
    return {
      valid: false,
      error: `Template SHA-256 mismatch. Got: ${hash}. Not in controlled registry.`,
    };
  }
  if (entry.mappingVersion !== MAPPING_VERSION) {
    return {
      valid: false,
      error: `Mapping version mismatch. Registry: ${entry.mappingVersion}, Current: ${MAPPING_VERSION}`,
    };
  }
  return { valid: true, entry };
}
