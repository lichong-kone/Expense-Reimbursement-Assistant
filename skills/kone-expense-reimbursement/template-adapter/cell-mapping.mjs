/**
 * Cell Mapping — Versioned physical mapping for 1.报销申请_template.xlsx
 *
 * Replicates the server-side CATEGORY_COL_MAP and layout constants exactly.
 * Any change to the official template requires a mapping version bump.
 *
 * CONTROLLED INTERNAL USE ONLY — do not distribute outside the organization.
 */

/** Mapping version — must match when verifying bundle integrity. */
export const MAPPING_VERSION = '1.0.0';

// ─── Header Cells ────────────────────────────────────────────────────

export const HEADER_CELLS = {
  employeeNo:   'A7',
  name:         'C7',
  employeeType: 'D7',
  department:   'G6',
  title:        'G7',
  costCenter:   'M6',
};

// ─── Data Row Layout ─────────────────────────────────────────────────

/** First data row (1-indexed Excel row number). */
export const DATA_ROW_START = 14;
/** Last data row (inclusive). */
export const DATA_ROW_END = 28;
/** Maximum data rows per file. */
export const MAX_DATA_ROWS = 15;

/** Column letters for per-row standard fields. */
export const ROW_COLUMNS = {
  date:         'A',
  city:         'B',
  description:  'C',
  currency:     'D',
  exchangeRate: 'F',
};

// ─── Category → Column (0-indexed, matching server CATEGORY_COL_MAP) ─

export const CATEGORY_COL_MAP = {
  hotel:          8,
  accommodation:  8,
  transport:      9,
  transportation: 9,
  travel_other:   10,
  meal:           10,
  meals:          10,
  welfare:        11,
  entertainment:  12,
  gift:           13,
  mobile:         14,
  other:          15,
  vat_tax:        16,
};

/**
 * Convert a 0-indexed column number to an Excel letter.
 * @param {number} col - 0-indexed column
 * @returns {string}
 */
export function colToLetter(col) {
  return String.fromCharCode(65 + col);
}

/**
 * Get the set of all cell addresses that are authorized for writing.
 * Used for fidelity verification — only these cells may differ from the template.
 * @param {number} rowCount - Number of data rows actually written (1–15).
 * @returns {Set<string>}
 */
export function getAuthorizedCells(rowCount) {
  const cells = new Set();

  // Header cells
  for (const ref of Object.values(HEADER_CELLS)) {
    cells.add(ref);
  }

  // Data row cells
  const actualRows = Math.min(rowCount, MAX_DATA_ROWS);
  for (let i = 0; i < actualRows; i++) {
    const row = DATA_ROW_START + i;
    for (const col of Object.values(ROW_COLUMNS)) {
      cells.add(`${col}${row}`);
    }
    // Category columns (8–16)
    for (let c = 8; c <= 16; c++) {
      cells.add(`${colToLetter(c)}${row}`);
    }
  }

  return cells;
}
