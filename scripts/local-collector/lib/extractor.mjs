/**
 * Extraction Adapter — Converts raw files in inbox to structured invoice JSON.
 *
 * Handles:
 *   .pdf  → pdf-parse text extraction
 *   .ofd  → adm-zip decompress + XML read
 *   .xml  → Direct invoice XML tag parsing
 *   .png/.jpg/.jpeg → tesseract.js OCR fallback
 *   .json/.txt → Already extracted, skip
 *
 * Output: {filename}.extracted.json written alongside the original in inbox.
 * State tracks which files have already been extracted (by SHA-256 hash).
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Pure helpers (testable) ─────────────────────────────────────────

/**
 * Classify a file by its extension for extraction dispatch.
 * Returns: 'pdf' | 'ofd' | 'xml' | 'image' | 'text' | 'json' | 'skip'
 */
export function classifyFileType(filename) {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf': return 'pdf';
    case '.ofd': return 'ofd';
    case '.xml': return 'xml';
    case '.png': case '.jpg': case '.jpeg': return 'image';
    case '.txt': return 'text';
    case '.json': return 'json';
    default: return 'skip';
  }
}

/**
 * Compute SHA-256 of file content for dedup tracking.
 */
export function fileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Parse Chinese electronic invoice XML to extract key fields.
 * Handles common tags from 全电发票 (fully electronic invoice) XML.
 */
export function parseInvoiceXml(xmlContent) {
  const fields = {};

  // Common tag patterns in Chinese e-invoice XML
  const patterns = [
    { key: 'invoiceNumber', regex: /<(?:InvoiceNo|发票号码|FpHm)>([^<]+)/i },
    { key: 'invoiceDate', regex: /<(?:InvoiceDate|开票日期|Kprq)>([^<]+)/i },
    { key: 'amount', regex: /<(?:TotalAmount|价税合计|Jshj|AmountTax)>([^<]+)/i },
    { key: 'sellerName', regex: /<(?:SellerName|销售方名称|Xfmc)>([^<]+)/i },
    { key: 'buyerName', regex: /<(?:BuyerName|购买方名称|Gfmc)>([^<]+)/i },
    { key: 'taxAmount', regex: /<(?:TaxAmount|税额|Se)>([^<]+)/i },
  ];

  for (const { key, regex } of patterns) {
    const m = xmlContent.match(regex);
    if (m) fields[key] = m[1].trim();
  }

  return fields;
}

// ─── Extraction functions ────────────────────────────────────────────

async function extractPdf(filePath) {
  // Dynamic import — pdf-parse is a CJS module
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = readFileSync(filePath);
  const data = await pdfParse(buffer);
  return { rawText: data.text || '' };
}

async function extractOfd(filePath) {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Look for XML invoice data inside OFD archive
  let xmlContent = '';
  for (const entry of entries) {
    const name = entry.entryName.toLowerCase();
    if (name.includes('invoice') || name.includes('ofd') || name.endsWith('.xml')) {
      xmlContent += entry.getData().toString('utf-8') + '\n';
    }
  }

  if (xmlContent) {
    const fields = parseInvoiceXml(xmlContent);
    if (Object.keys(fields).length > 0) {
      return { rawText: xmlContent.slice(0, 2000), preParsed: fields };
    }
    return { rawText: xmlContent.slice(0, 2000) };
  }

  return { rawText: '[OFD] 未能提取发票文本' };
}

async function extractXml(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const fields = parseInvoiceXml(content);
  if (Object.keys(fields).length > 0) {
    return { rawText: content.slice(0, 2000), preParsed: fields };
  }
  return { rawText: content.slice(0, 2000) };
}

async function extractImage(filePath) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('chi_sim+eng');
  try {
    const { data: { text } } = await worker.recognize(filePath);
    return { rawText: text || '' };
  } finally {
    await worker.terminate();
  }
}

// ─── Main extraction orchestrator ───────────────────────────────────

/**
 * Extract all new (un-extracted) files in inboxDir.
 * Tracks extracted files by hash in statePath to avoid re-extraction.
 *
 * @param {string} inboxDir - Path to the inbox folder
 * @param {string} statePath - Path to the state JSON file
 * @returns {Promise<number>} Number of newly extracted files
 */
export async function extractNewFiles(inboxDir, statePath) {
  if (!existsSync(inboxDir)) return 0;

  // Load extraction state
  let state = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch { state = {}; }
  }
  if (!state.extractedHashes) state.extractedHashes = [];
  const extractedSet = new Set(state.extractedHashes);

  const entries = readdirSync(inboxDir);
  let count = 0;

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (entry.endsWith('.extracted.json')) continue; // skip our own output

    const filePath = join(inboxDir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) continue;

    const type = classifyFileType(entry);
    if (type === 'skip') continue;

    // Already has an extracted.json companion?
    const extractedPath = join(inboxDir, basename(entry, extname(entry)) + '.extracted.json');
    if (existsSync(extractedPath)) continue;

    // json/txt are already in extracted format — just validate
    if (type === 'json' || type === 'text') continue;

    // Hash-based dedup
    const content = readFileSync(filePath);
    const hash = fileHash(content);
    if (extractedSet.has(hash)) continue;

    // Extract based on type
    let result = null;
    try {
      switch (type) {
        case 'pdf': result = await extractPdf(filePath); break;
        case 'ofd': result = await extractOfd(filePath); break;
        case 'xml': result = await extractXml(filePath); break;
        case 'image': result = await extractImage(filePath); break;
      }
    } catch (err) {
      console.warn(`    ⚠ 提取失败 ${entry}: ${err.message}`);
      result = { rawText: `[提取失败] ${err.message}` };
    }

    if (result) {
      const invoiceData = {
        id: basename(entry, extname(entry)),
        fileName: entry,
        ...result,
      };
      writeFileSync(extractedPath, JSON.stringify(invoiceData, null, 2), 'utf-8');
      extractedSet.add(hash);
      count++;
    }
  }

  // Persist extraction state
  state.extractedHashes = [...extractedSet];
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

  return count;
}
