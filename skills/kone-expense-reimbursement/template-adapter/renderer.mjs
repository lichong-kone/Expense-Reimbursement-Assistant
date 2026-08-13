/**
 * Controlled OOXML Renderer — Renders a formal expense Excel from the official template.
 *
 * Technique: Open official .xlsx template as a zip (adm-zip), patch ONLY authorized
 * worksheet cells via XML string manipulation, preserve every other OOXML component
 * byte-for-byte (formulas, styles, merges, checkboxes, print settings, drawings).
 *
 * This module is a standalone adapter — it requires `adm-zip` (already in package.json).
 * The policy core (portable-core.mjs) remains zero-dependency.
 *
 * CONTROLLED INTERNAL USE ONLY — do not distribute outside the organization.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import AdmZip from 'adm-zip';

import {
  MAPPING_VERSION,
  HEADER_CELLS,
  DATA_ROW_START,
  MAX_DATA_ROWS,
  ROW_COLUMNS,
  CATEGORY_COL_MAP,
  colToLetter,
  getAuthorizedCells,
} from './cell-mapping.mjs';

import {
  TEMPLATE_PACK_VERSION,
  CONTROLLED_TEMPLATES,
  computeSha256,
  validateTemplateHash,
} from './template-pack.mjs';

// ─── OOXML Constants ─────────────────────────────────────────────────

const WORKSHEET_ENTRY = 'xl/worksheets/sheet1.xml';
const CRITICAL_ENTRIES = [
  'xl/workbook.xml',
  'xl/styles.xml',
];

// ─── XML Patching Utilities (mirrors server patcher logic) ───────────

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNumericCell(openingTag) {
  const attrs = openingTag.replace(/\/?\s*>$/, '').replace(/\s+t=(?:"[^"]*"|'[^']*')/g, '');
  return `${attrs}>`;
}

function toInlineStringCell(openingTag) {
  const attrs = openingTag.replace(/\/?\s*>$/, '').replace(/\s+t=(?:"[^"]*"|'[^']*')/g, '');
  return `${attrs} t="inlineStr">`;
}

function toEmptyCell(openingTag) {
  const attrs = openingTag.replace(/\/?\s*>$/, '');
  return `${attrs}/>`;
}

/**
 * Patch a single cell in the worksheet XML.
 * @param {string} xml - Current worksheet XML
 * @param {string} ref - Cell reference (e.g. "A7")
 * @param {string|number|null} value - Value to write
 * @returns {{ xml: string, found: boolean }}
 */
function patchCell(xml, ref, value) {
  if (!/^[A-Z]+[1-9]\d*$/.test(ref)) {
    throw new Error(`Invalid cell address: ${ref}`);
  }

  const attributePattern = `(?=[^>]*\\br=(?:"${escapeRegExp(ref)}"|'${escapeRegExp(ref)}'))[^>]*`;
  const selfClosing = new RegExp(`<c\\b${attributePattern}\\/>`);
  const normal = new RegExp(`<c\\b${attributePattern}>[\\s\\S]*?<\\/c>`);
  const match = xml.match(selfClosing) ?? xml.match(normal);
  if (!match) return { xml, found: false };

  const original = match[0];
  const opening = original.match(/^<c\b[^>]*>/)?.[0]
    ?? original.match(/^<c\b[^>]*\/>/)?.[0];
  if (!opening) throw new Error(`Cannot parse cell element: ${ref}`);

  let replacement;
  if (value === null || value === '' || value === undefined) {
    replacement = toEmptyCell(opening);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for ${ref}`);
    replacement = `${toNumericCell(opening)}<v>${value}</v></c>`;
  } else {
    replacement = `${toInlineStringCell(opening)}<is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`;
  }

  return { xml: xml.replace(original, replacement), found: true };
}

/**
 * Convert a date string (YYYY-MM-DD) to Excel serial number.
 * Uses the 1900 date system with the historical Lotus 1-2-3 leap-year bug.
 */
function toExcelDateSerial(dateStr) {
  if (!dateStr) return null;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return null;
  return Math.round((parsed.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// ─── Render Input Interface ──────────────────────────────────────────

/**
 * @typedef {Object} RenderInput
 * @property {Object} employee - Employee header info
 * @property {string} [employee.employeeNo]
 * @property {string} [employee.name]
 * @property {string} [employee.employeeType]
 * @property {string} [employee.department]
 * @property {string} [employee.title]
 * @property {string} [employee.costCenter]
 * @property {Array<RenderRow>} rows - Data rows from template-input.json
 */

/**
 * @typedef {Object} RenderRow
 * @property {string} date - YYYY-MM-DD
 * @property {string} city
 * @property {string} purpose - Description/purpose text
 * @property {string} category - Expense category key
 * @property {number} reimbursableAmount - Amount to write
 * @property {number} [actualAmount]
 * @property {string} [currency]
 * @property {number} [exchangeRate]
 * @property {string|null} [settlement]
 * @property {string|null} [reason]
 */

// ─── Main Render Function ────────────────────────────────────────────

/**
 * Render the controlled expense Excel from official template + template-input data.
 *
 * @param {Object} options
 * @param {string} options.templatePath - Path to official .xlsx template
 * @param {string} options.outputDir - Directory for output files
 * @param {RenderInput} options.data - Template-input data (from portable-core output)
 * @param {string} [options.filePrefix] - Output file name prefix
 * @returns {Object} Render result with files, manifest info, and verification status
 */
export function renderControlledExcel(options) {
  const { templatePath, outputDir, data, filePrefix = '1.报销申请' } = options;

  // ── Step 1: Validate template hash ──
  const templateValidation = validateTemplateHash(templatePath);
  if (!templateValidation.valid) {
    return {
      success: false,
      error: templateValidation.error,
      files: [],
      fidelityVerification: { passed: false, reason: templateValidation.error },
    };
  }

  const templateEntry = templateValidation.entry;
  const templateHash = templateEntry.sha256;

  // ── Step 2: Validate mapping version ──
  if (templateEntry.mappingVersion !== MAPPING_VERSION) {
    const err = `Mapping version mismatch: template registry expects ${templateEntry.mappingVersion}, adapter has ${MAPPING_VERSION}`;
    return {
      success: false,
      error: err,
      files: [],
      fidelityVerification: { passed: false, reason: err },
    };
  }

  // ── Step 3: Validate row count ──
  const rows = data.rows || [];
  if (rows.length > MAX_DATA_ROWS * 100) {
    const err = `Too many rows (${rows.length}): exceeds reasonable limit`;
    return {
      success: false,
      error: err,
      files: [],
      fidelityVerification: { passed: false, reason: err },
    };
  }

  // ── Step 4: Split into chunks if >15 rows ──
  const chunks = [];
  for (let i = 0; i < rows.length; i += MAX_DATA_ROWS) {
    chunks.push(rows.slice(i, i + MAX_DATA_ROWS));
  }
  if (chunks.length === 0) chunks.push([]);

  // ── Step 5: Render each chunk ──
  mkdirSync(outputDir, { recursive: true });
  const files = [];
  const allVerifications = [];

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const suffix = chunks.length > 1 ? `-${chunkIdx + 1}` : '';
    const fileName = `${filePrefix}-${data.employee?.name || 'export'}${suffix}.xlsx`;
    const outputPath = join(outputDir, fileName);

    const result = renderSingleFile({
      templatePath,
      outputPath,
      employee: data.employee || {},
      rows: chunk,
      templateHash,
    });

    files.push({
      name: fileName,
      path: outputPath,
      sha256: result.outputHash,
      rowCount: chunk.length,
    });
    allVerifications.push(result.verification);
  }

  // ── Step 6: Aggregate fidelity result ──
  const allPassed = allVerifications.every(v => v.passed);
  const fidelityVerification = {
    passed: allPassed,
    templateSha256: templateHash,
    mappingVersion: MAPPING_VERSION,
    templatePackVersion: TEMPLATE_PACK_VERSION,
    fileCount: files.length,
    details: allVerifications,
    reason: allPassed ? 'All files pass fidelity verification' : 'One or more files failed fidelity check',
  };

  return {
    success: allPassed,
    files,
    fidelityVerification,
    error: allPassed ? null : 'Fidelity verification failed; output is not submittable',
  };
}

// ─── Single File Renderer ────────────────────────────────────────────

function renderSingleFile({ templatePath, outputPath, employee, rows, templateHash }) {
  const templateBuffer = readFileSync(templatePath);
  const zip = new AdmZip(templateBuffer);

  // Read the original critical entries for later comparison
  const originalCritical = {};
  for (const entry of CRITICAL_ENTRIES) {
    const zipEntry = zip.getEntry(entry);
    if (zipEntry) {
      originalCritical[entry] = zipEntry.getData();
    }
  }

  // Read original sharedStrings if present
  const sharedStringsEntry = zip.getEntry('xl/sharedStrings.xml');
  const originalSharedStrings = sharedStringsEntry ? sharedStringsEntry.getData() : null;

  // Get the worksheet XML
  const worksheetEntry = zip.getEntry(WORKSHEET_ENTRY);
  if (!worksheetEntry) {
    throw new Error(`Template missing ${WORKSHEET_ENTRY}`);
  }
  let worksheetXml = worksheetEntry.getData().toString('utf8');

  // ── Patch header cells ──
  const headerPatches = [
    { ref: HEADER_CELLS.employeeNo, value: employee.employeeNo || employee.employeeId || null },
    { ref: HEADER_CELLS.name, value: employee.name || null },
    { ref: HEADER_CELLS.employeeType, value: employee.employeeType || null },
    { ref: HEADER_CELLS.department, value: employee.department || null },
    { ref: HEADER_CELLS.title, value: employee.title || employee.position || null },
    { ref: HEADER_CELLS.costCenter, value: employee.costCenter || null },
  ];

  for (const patch of headerPatches) {
    const result = patchCell(worksheetXml, patch.ref, patch.value);
    if (result.found) worksheetXml = result.xml;
  }

  // ── Patch data rows ──
  const rowCount = Math.min(rows.length, MAX_DATA_ROWS);
  for (let i = 0; i < rowCount; i++) {
    const row = rows[i];
    const excelRow = DATA_ROW_START + i;

    // Date
    const dateSerial = toExcelDateSerial(row.date);
    const dateResult = patchCell(worksheetXml, `${ROW_COLUMNS.date}${excelRow}`, dateSerial);
    if (dateResult.found) worksheetXml = dateResult.xml;

    // City
    const cityResult = patchCell(worksheetXml, `${ROW_COLUMNS.city}${excelRow}`, row.city || null);
    if (cityResult.found) worksheetXml = cityResult.xml;

    // Description/purpose
    const descResult = patchCell(worksheetXml, `${ROW_COLUMNS.description}${excelRow}`, row.purpose || null);
    if (descResult.found) worksheetXml = descResult.xml;

    // Currency
    const currResult = patchCell(worksheetXml, `${ROW_COLUMNS.currency}${excelRow}`, row.currency || 'RMB');
    if (currResult.found) worksheetXml = currResult.xml;

    // Exchange rate
    const rateValue = row.exchangeRate ?? 1.0;
    const rateResult = patchCell(worksheetXml, `${ROW_COLUMNS.exchangeRate}${excelRow}`, rateValue);
    if (rateResult.found) worksheetXml = rateResult.xml;

    // Category amount → appropriate column
    const categoryKey = row.category || 'other';
    const catCol = CATEGORY_COL_MAP[categoryKey] ?? CATEGORY_COL_MAP.other;
    const catRef = `${colToLetter(catCol)}${excelRow}`;
    const amountValue = row.reimbursableAmount ?? row.amount ?? 0;
    const catResult = patchCell(worksheetXml, catRef, amountValue);
    if (catResult.found) worksheetXml = catResult.xml;
  }

  // ── Write modified worksheet back ──
  zip.updateFile(WORKSHEET_ENTRY, Buffer.from(worksheetXml, 'utf8'));

  // ── Write output file ──
  mkdirSync(dirname(outputPath), { recursive: true });
  zip.writeZip(outputPath);

  // ── Fidelity verification ──
  const verification = verifyFidelity({
    outputPath,
    templateBuffer,
    originalCritical,
    originalSharedStrings,
    rowCount,
  });

  const outputHash = computeSha256(outputPath);

  return { outputHash, verification };
}

// ─── Fidelity Verification ───────────────────────────────────────────

/**
 * Verify that the output file only differs in authorized cells.
 * Critical OOXML parts (workbook.xml, styles.xml) must be byte-identical.
 */
function verifyFidelity({ outputPath, templateBuffer, originalCritical, originalSharedStrings, rowCount }) {
  try {
    const outputZip = new AdmZip(outputPath);

    // Check critical entries are byte-identical
    for (const [entry, originalData] of Object.entries(originalCritical)) {
      const outputEntry = outputZip.getEntry(entry);
      if (!outputEntry) {
        return { passed: false, reason: `Missing critical entry: ${entry}` };
      }
      const outputData = outputEntry.getData();
      if (!originalData.equals(outputData)) {
        return { passed: false, reason: `Critical entry modified: ${entry}` };
      }
    }

    // Check sharedStrings is unchanged (if it existed in template)
    if (originalSharedStrings) {
      const outputSS = outputZip.getEntry('xl/sharedStrings.xml');
      if (outputSS) {
        const outputSSData = outputSS.getData();
        if (!originalSharedStrings.equals(outputSSData)) {
          return { passed: false, reason: 'sharedStrings.xml was modified' };
        }
      }
    }

    // Verify only authorized cells were modified in the worksheet
    const templateZip = new AdmZip(templateBuffer);
    const origWs = templateZip.getEntry(WORKSHEET_ENTRY)?.getData().toString('utf8');
    const outWs = outputZip.getEntry(WORKSHEET_ENTRY)?.getData().toString('utf8');

    if (!origWs || !outWs) {
      return { passed: false, reason: 'Cannot read worksheet for comparison' };
    }

    // Extract all cell refs that differ
    const authorizedCells = getAuthorizedCells(rowCount);
    const modifiedCells = findModifiedCells(origWs, outWs);

    for (const cellRef of modifiedCells) {
      if (!authorizedCells.has(cellRef)) {
        return { passed: false, reason: `Unauthorized cell modified: ${cellRef}` };
      }
    }

    return { passed: true, reason: 'Only authorized cells modified; critical parts unchanged' };
  } catch (err) {
    return { passed: false, reason: `Verification error: ${err.message}` };
  }
}

/**
 * Find all cell references that differ between two worksheet XMLs.
 * @param {string} origXml
 * @param {string} outXml
 * @returns {Set<string>}
 */
function findModifiedCells(origXml, outXml) {
  const modified = new Set();

  // Extract all cells from both
  const origCells = extractCells(origXml);
  const outCells = extractCells(outXml);

  // Find cells that differ
  const allRefs = new Set([...origCells.keys(), ...outCells.keys()]);
  for (const ref of allRefs) {
    const origContent = origCells.get(ref) || '';
    const outContent = outCells.get(ref) || '';
    if (origContent !== outContent) {
      modified.add(ref);
    }
  }

  return modified;
}

/**
 * Extract all cells from worksheet XML as a Map<ref, fullCellXml>.
 * Uses sequential scanning to correctly handle both self-closing (<c .../>)
 * and open-close (<c ...>...</c>) elements.
 * @param {string} xml
 * @returns {Map<string, string>}
 */
function extractCells(xml) {
  const cells = new Map();
  let pos = 0;
  while (true) {
    const start = xml.indexOf('<c ', pos);
    if (start === -1) break;

    // Find the end of the opening tag (first > after start)
    const closeAngle = xml.indexOf('>', start);
    if (closeAngle === -1) break;

    let cellXml;
    if (xml[closeAngle - 1] === '/') {
      // Self-closing: <c ... />
      cellXml = xml.substring(start, closeAngle + 1);
      pos = closeAngle + 1;
    } else {
      // Open-close: <c ...>...</c>
      const endTag = xml.indexOf('</c>', closeAngle);
      if (endTag === -1) break;
      cellXml = xml.substring(start, endTag + 4);
      pos = endTag + 4;
    }

    const refMatch = cellXml.match(/\br=(?:"([^"]+)"|'([^']+)')/);
    if (refMatch) {
      const ref = refMatch[1] || refMatch[2];
      cells.set(ref, cellXml);
    }
  }
  return cells;
}
