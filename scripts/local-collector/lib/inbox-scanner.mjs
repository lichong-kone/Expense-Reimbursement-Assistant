/**
 * Inbox Scanner — Scans the inbox folder for extracted invoice items
 * and assembles them into a PortableSkillInput structure.
 *
 * Reads both:
 * - .extracted.json files (output of extractor.mjs)
 * - .json files (already in invoice format)
 * - .txt files (treated as rawText)
 * - manifest.json (if present, for explicit listing)
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

/**
 * Scan inbox directory and return array of invoice items
 * conforming to PortableSkillInput.invoices[*] schema.
 */
export function scanInbox(inboxDir) {
  if (!existsSync(inboxDir)) return [];

  const manifestPath = join(inboxDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    return scanFromManifest(manifestPath, inboxDir);
  }

  return scanFromFiles(inboxDir);
}

function scanFromManifest(manifestPath, inboxDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch { return []; }

  if (!Array.isArray(manifest.items)) return [];

  const items = [];
  for (const item of manifest.items) {
    if (item.file) {
      const filePath = join(inboxDir, item.file);
      if (!existsSync(filePath)) continue;
      const parsed = readInvoiceFile(filePath);
      if (parsed) items.push({ ...parsed, ...(item.metadata || {}) });
    } else if (item.rawText || item.preParsed) {
      items.push({ id: item.id || `manifest_${items.length + 1}`, ...item });
    }
  }
  return items;
}

function scanFromFiles(inboxDir) {
  const entries = readdirSync(inboxDir);
  const items = [];
  const seen = new Set(); // Track base names to avoid double-counting

  // First pass: .extracted.json files (higher priority)
  for (const entry of entries) {
    if (!entry.endsWith('.extracted.json')) continue;
    if (entry.startsWith('.')) continue;

    const filePath = join(inboxDir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) continue;

    const parsed = readInvoiceFile(filePath);
    if (parsed) {
      items.push(parsed);
      // Mark the base name as seen so we don't double-count
      const base = entry.replace('.extracted.json', '');
      seen.add(base);
    }
  }

  // Second pass: .json and .txt files (not .extracted.json, not already seen)
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (entry === 'manifest.json') continue;
    if (entry.endsWith('.extracted.json')) continue;

    const ext = extname(entry).toLowerCase();
    if (ext !== '.json' && ext !== '.txt') continue;

    const base = basename(entry, ext);
    if (seen.has(base)) continue; // Already have .extracted.json for this

    const filePath = join(inboxDir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) continue;

    const parsed = readInvoiceFile(filePath);
    if (parsed) {
      items.push(parsed);
      seen.add(base);
    }
  }

  return items;
}

/**
 * Read a single invoice file and return a PortableSkillInput.invoices[*] object.
 */
function readInvoiceFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath, ext);

  try {
    const content = readFileSync(filePath, 'utf-8').trim();

    if (ext === '.json') {
      const obj = JSON.parse(content);
      return { id: obj.id || name, fileName: basename(filePath), ...obj };
    }

    if (ext === '.txt') {
      return {
        id: name,
        rawText: content,
        fileName: basename(filePath),
      };
    }
  } catch (e) {
    // Skip unreadable files
  }
  return null;
}

/**
 * Assemble a complete PortableSkillInput from invoice items and config.
 */
export function assembleInput(invoiceItems, employee, trip) {
  const input = { employee, invoices: invoiceItems };
  if (trip) input.trip = trip;
  return input;
}
