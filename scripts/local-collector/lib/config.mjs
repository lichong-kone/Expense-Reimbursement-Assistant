/**
 * Configuration loader and resolver for the local collector.
 *
 * sources.json schema:
 * {
 *   version: "1.0.0",
 *   mode: "local" | "mailbox" | "both",
 *   inboxDir: string,
 *   outputDir: string,
 *   statePath?: string,
 *   employee: { ... } | undefined,
 *   employeeFile?: string,
 *   trip?: { ... } | undefined,
 *   tripFile?: string,
 *   mailbox?: { host, port, secure, user, passwordEnv, folder?, sinceDays? },
 *   excel?: boolean
 * }
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Load and parse sources.json from the given path.
 */
export function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    console.error(`配置文件不存在: ${configPath}`);
    console.error('请先运行引导式配置生成 sources.json：');
    console.error('  node scripts/local-collector/setup.mjs --help');
    console.error('（或参见 scripts/local-collector/README.md）');
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`无法解析配置文件 ${configPath}: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Resolve a raw config object into fully-resolved absolute paths and defaults.
 * @param {object} raw - Parsed sources.json content
 * @param {string} baseDir - Directory containing sources.json (for relative path resolution)
 * @returns {object} Resolved configuration
 */
export function resolveConfig(raw, baseDir) {
  const mode = raw.mode || 'local';
  if (!['local', 'mailbox', 'both'].includes(mode)) {
    console.error(`无效的 mode: "${mode}"，允许值: local, mailbox, both`);
    process.exit(1);
  }

  const inboxDir = resolve(baseDir, raw.inboxDir || './inbox');
  const outputDir = resolve(baseDir, raw.outputDir || './output');
  const statePath = resolve(baseDir, raw.statePath || './state.json');

  // Employee: inline or file reference
  let employee = raw.employee || null;
  if (!employee && raw.employeeFile) {
    const empPath = resolve(baseDir, raw.employeeFile);
    if (existsSync(empPath)) {
      employee = JSON.parse(readFileSync(empPath, 'utf-8'));
    } else {
      console.error(`employeeFile 不存在: ${empPath}`);
      process.exit(1);
    }
  }
  if (!employee) {
    employee = {
      name: '待填写',
      employeeId: '',
      department: '',
      position: '',
      costCenter: '',
      level: 'staff',
    };
    console.warn('⚠ 未配置 employee 信息，使用默认占位值。');
  }

  // Trip: optional, inline or file reference
  let trip = raw.trip || null;
  if (!trip && raw.tripFile) {
    const tripPath = resolve(baseDir, raw.tripFile);
    if (existsSync(tripPath)) {
      trip = JSON.parse(readFileSync(tripPath, 'utf-8'));
    }
  }

  // Mailbox config
  const mailbox = raw.mailbox || null;

  // Excel generation flag
  const excel = raw.excel !== false; // default true

  return { mode, inboxDir, outputDir, statePath, employee, trip, mailbox, excel };
}
