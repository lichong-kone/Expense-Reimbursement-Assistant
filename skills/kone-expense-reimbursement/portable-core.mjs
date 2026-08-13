#!/usr/bin/env node
/**
 * KONE Expense Reimbursement — Portable Core + CLI
 *
 * Self-contained Node.js .mjs module. Zero external dependencies.
 * Requires Node >= 18 (for fs/promises, structuredClone, URL).
 *
 * Usage:
 *   node portable-core.mjs --input input.json [--output-dir ./output]
 *   node portable-core.mjs --help
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Hashing Utility ─────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a string or Buffer. */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Decision Types & Validation (§6.8.3) ────────────────────────────

/**
 * Allowed field patches for 'adjust' and 'provide_info' decisions.
 * Only these fields may be modified via decisions (safe allowlist).
 */
const ALLOWED_DECISION_FIELDS = [
  'totalAmount', 'amount', 'invoiceDate', 'tripDate', 'city',
  'transportFrom', 'transportTo', 'transportType', 'sellerName',
  'invoiceNumber', 'invoiceType', 'expenseCategory',
];

/**
 * Validate a single decision object.
 * Returns { valid: boolean, errors: string[] }
 */
function validateDecision(decision, reviewQuestions) {
  const errors = [];
  if (!decision || typeof decision !== 'object') {
    return { valid: false, errors: ['Decision must be a non-null object'] };
  }
  if (!decision.questionId || typeof decision.questionId !== 'string') {
    errors.push('Decision must have a string questionId');
  }
  if (!decision.action || typeof decision.action !== 'string') {
    errors.push('Decision must have a string action');
  }

  // Must reference a valid question
  const matchingQ = reviewQuestions.find(q => q.questionId === decision.questionId);
  if (!matchingQ) {
    errors.push(`questionId "${decision.questionId}" does not match any review question`);
    return { valid: false, errors };
  }

  // Action must be in the question's availableActions
  if (!matchingQ.availableActions.includes(decision.action)) {
    errors.push(`action "${decision.action}" not in allowed actions [${matchingQ.availableActions.join(', ')}] for question ${decision.questionId}`);
  }

  // exempt requires a reason
  if (decision.action === 'exempt') {
    if (!decision.reason || typeof decision.reason !== 'string' || decision.reason.trim().length === 0) {
      errors.push(`action "exempt" requires a non-empty "reason" string`);
    }
  }

  // adjust/provide_info requires fieldPatch with only allowed fields
  if (decision.action === 'adjust' || decision.action === 'provide_info') {
    if (!decision.fieldPatch || typeof decision.fieldPatch !== 'object' || Object.keys(decision.fieldPatch).length === 0) {
      errors.push(`action "${decision.action}" requires a non-empty "fieldPatch" object`);
    } else {
      for (const key of Object.keys(decision.fieldPatch)) {
        if (!ALLOWED_DECISION_FIELDS.includes(key)) {
          errors.push(`fieldPatch key "${key}" is not in the allowed fields list`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate all decisions.
 * Returns { valid: boolean, results: Array<{questionId, valid, errors}> }
 */
function validateAllDecisions(decisions, reviewQuestions) {
  if (!Array.isArray(decisions)) {
    return { valid: false, results: [{ questionId: '?', valid: false, errors: ['Decisions must be an array'] }] };
  }
  const results = decisions.map(d => {
    const r = validateDecision(d, reviewQuestions);
    return { questionId: d?.questionId || '?', valid: r.valid, errors: r.errors };
  });
  const valid = results.every(r => r.valid);
  return { valid, results };
}

/**
 * Apply valid decisions to results and re-run checks.
 * Returns updated results and audit entries.
 */
function applyDecisions(decisions, results, reviewQuestions, snapshot, employeeLevel) {
  const auditEntries = [];
  const ts = new Date().toISOString();

  for (const decision of decisions) {
    const question = reviewQuestions.find(q => q.questionId === decision.questionId);
    if (!question) continue;

    const invoiceId = question.invoiceId;
    const item = results.find(r => r.id === invoiceId);
    if (!item) continue;

    if (decision.action === 'exempt') {
      // Mark the item as user-exempted; clear the need_confirm for this specific issue
      auditEntries.push({
        timestamp: ts,
        action: 'decision_exempt',
        invoiceId,
        details: { questionId: decision.questionId, reason: decision.reason, ruleId: question.sourceRuleId },
      });
    } else if (decision.action === 'adjust' || decision.action === 'provide_info') {
      // Apply field patches
      for (const [key, value] of Object.entries(decision.fieldPatch)) {
        if (ALLOWED_DECISION_FIELDS.includes(key)) {
          item.fields[key] = value;
        }
      }
      // Re-derive status after patching
      const missing = missingRequiredFields(item.fields.invoiceType, item.fields);
      item.missingFields = missing.filter(f => f !== 'suspected_duplicate');
      // Preserve suspected_duplicate if it was there
      if (item._wasDuplicate) item.missingFields.push('suspected_duplicate');
      item.status = deriveStatus(item.fields.invoiceType, item.fields, item.confidence);

      auditEntries.push({
        timestamp: ts,
        action: 'decision_patch',
        invoiceId,
        details: { questionId: decision.questionId, action: decision.action, fieldPatch: decision.fieldPatch },
      });
    } else if (decision.action === 'keep') {
      auditEntries.push({
        timestamp: ts,
        action: 'decision_keep',
        invoiceId,
        details: { questionId: decision.questionId },
      });
    } else if (decision.action === 'defer') {
      auditEntries.push({
        timestamp: ts,
        action: 'decision_defer',
        invoiceId,
        details: { questionId: decision.questionId },
      });
    }
  }

  // Re-run policy checks after patches
  const newChecks = [];
  for (const r of results) {
    const checks = checkPolicy(r, employeeLevel, snapshot);
    newChecks.push(...checks);
  }

  return { updatedResults: results, updatedChecks: newChecks, decisionAuditEntries: auditEntries };
}

// ─── Load policy rules snapshot ──────────────────────────────────────

const RULES_PATH = join(__dirname, 'resources', 'policy-rules.json');

let _policySnapshot = null;
async function loadPolicyRules() {
  if (_policySnapshot) return _policySnapshot;
  const raw = await readFile(RULES_PATH, 'utf-8');
  _policySnapshot = JSON.parse(raw);
  return _policySnapshot;
}

// ─── City Normalization ──────────────────────────────────────────────

const SUBCITY_TO_PRIMARY = [
  { city: '苏州', aliases: ['昆山', '张家港', '常熟', '太仓', '吴江', '吴中', '相城', '虎丘', '姑苏', '苏州北', '苏州南', '苏州东', '苏州西', '苏州园区', '苏州新区'] },
  { city: '上海', aliases: ['浦东', '虹桥', '闵行', '徐汇', '静安', '黄浦', '嘉定', '松江', '宝山', '青浦', '奉贤', '崇明'] },
  { city: '北京', aliases: ['首都机场', '大兴机场', '朝阳区', '海淀区', '西城区', '东城区', '通州区'] },
  { city: '天津', aliases: ['滨海新区', '武清区', '西青区', '东丽区'] },
  { city: '重庆', aliases: ['渝北区', '江北区', '沙坪坝区', '南岸区'] },
];

const MUNICIPALITIES = ['北京', '上海', '天津', '重庆'];

export function normalizePrimaryCity(value) {
  const raw = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!raw) return '';

  for (const entry of SUBCITY_TO_PRIMARY) {
    if (entry.aliases.some((a) => raw.includes(a))) return entry.city;
  }
  for (const m of MUNICIPALITIES) {
    if (raw.includes(m)) return m;
  }

  const provincialCity = raw.match(/(?:省|自治区)([\u4e00-\u9fff]{2,10}?)(?:市|自治州|地区)/);
  if (provincialCity) return provincialCity[1];

  const city = raw.match(/([\u4e00-\u9fff]{2,10}?)(?:市|自治州|地区)/);
  if (city) return city[1];

  const english = raw.match(/\b(Shanghai|Suzhou|Beijing|Tianjin|Chongqing|Guangzhou|Shenzhen|Hangzhou|Nanjing|Wuxi|Ningbo|Xiamen|Qingdao|Dalian)\b/i);
  if (english) {
    const name = english[1].toLowerCase();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  return raw
    .split(/[，,;；/·｜|（(]/)[0]
    .replace(/(机场|高铁站|火车站|地铁站|站|航站楼|航站|候车室|停车场|地下层|楼|区|路|街|号).*$/u, '')
    .trim();
}

/** Resolve city tier from the policy snapshot. */
export function resolveCityTier(city, snapshot) {
  if (!city) return 'tier_3';
  const normalized = normalizePrimaryCity(city);
  const entry = snapshot.cityTiers.find(
    (ct) => ct.cityName === normalized || ct.cityName === city
  );
  return entry ? entry.tierCode : 'tier_3';
}

// ─── Basic Text/Subject/Filename Extraction ──────────────────────────

const INVOICE_TYPE_PATTERNS = [
  { type: 'taxi', keywords: ['出租', '网约车', '打车', '滴滴', '曹操', '首汽', 'taxi', 'ride', '快车', '专车'] },
  { type: 'flight', keywords: ['机票', '航空', '飞机', 'flight', 'airline', '航班', '登机'] },
  { type: 'hotel', keywords: ['酒店', '宾馆', '住宿', '旅馆', '民宿', 'hotel', 'accommodation', '如家', '汉庭', '全季'] },
  { type: 'railway', keywords: ['火车票', '铁路客票', '高铁票', '动车票', '列车票', '12306', '铁路电子'] },
  { type: 'meal', keywords: ['餐', '饮食', '食堂', '外卖', '美团', '饿了么', 'meal', 'restaurant', 'dining'] },
];

function detectInvoiceType(text) {
  const lower = (text || '').toLowerCase();
  for (const { type, keywords } of INVOICE_TYPE_PATTERNS) {
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return 'other';
}

const AMOUNT_RE = /[¥￥]\s*(\d{1,7}(?:[.,]\d{1,2}))/g;
const AMOUNT_KEYWORD_RE = /(?:金额|价税合计|合计|总额|amount|total)[：:\s]*(\d{1,7}(?:[.,]\d{1,2}))/gi;
const DATE_RE = /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})[日号]?/g;
const INVOICE_NUM_RE = /(?:发票号码|invoice\s*(?:no|number|#)?)[：:\s]*([A-Za-z0-9\-]+)/i;
const SELLER_RE = /(?:销售方|销方|卖方|seller)[：:\s名称]*([\u4e00-\u9fff]{2,30}(?:有限公司|公司|集团|店))/;
const CITY_RE = /([\u4e00-\u9fff]{2,6}?)(?:市|站|机场)/g;
const ROUTE_RE = /(?:从|出发|始发|from)\s*([\u4e00-\u9fff]{2,8})\s*(?:到|至|→|->|—|to)\s*([\u4e00-\u9fff]{2,8})/;
const TRANSPORT_TYPE_RE = /(?:二等座|一等座|商务座|硬座|软卧|硬卧|经济舱|商务舱|头等舱)/;

function extractFirstAmount(text) {
  if (!text) return null;
  // Priority 1: ¥ prefixed amounts
  const currencyMatches = [...text.matchAll(AMOUNT_RE)];
  if (currencyMatches.length > 0) {
    let max = 0;
    for (const m of currencyMatches) {
      const v = parseFloat(m[1].replace(',', ''));
      if (v > max) max = v;
    }
    if (max > 0) return max;
  }
  // Priority 2: keyword-prefixed amounts
  const kwMatches = [...text.matchAll(AMOUNT_KEYWORD_RE)];
  if (kwMatches.length > 0) {
    let max = 0;
    for (const m of kwMatches) {
      const v = parseFloat(m[1].replace(',', ''));
      if (v > max) max = v;
    }
    if (max > 0) return max;
  }
  return null;
}

function extractFirstDate(text) {
  if (!text) return null;
  const m = DATE_RE.exec(text);
  DATE_RE.lastIndex = 0;
  if (!m) return null;
  const month = m[2].padStart(2, '0');
  const day = m[3].padStart(2, '0');
  return `${m[1]}-${month}-${day}`;
}

function extractInvoiceNumber(text) {
  if (!text) return null;
  const m = text.match(INVOICE_NUM_RE);
  return m ? m[1].trim() : null;
}

function extractSeller(text) {
  if (!text) return null;
  const m = text.match(SELLER_RE);
  return m ? m[1].trim() : null;
}

function extractCity(text) {
  if (!text) return null;
  const matches = [...text.matchAll(CITY_RE)];
  CITY_RE.lastIndex = 0;
  if (matches.length > 0) return normalizePrimaryCity(matches[0][1]);

  // Fallback: look for known city names directly in text
  const KNOWN_CITIES = ['上海', '北京', '广州', '深圳', '杭州', '南京', '苏州', '厦门', '三亚', '大连', '青岛', '天津', '重庆', '武汉', '成都', '西安', '郑州', '长沙', '沈阳', '哈尔滨', '昆明', '无锡', '宁波', '福州', '合肥', '济南', '南昌', '贵阳'];
  for (const city of KNOWN_CITIES) {
    if (text.includes(city)) return city;
  }
  return null;
}

function extractRoute(text) {
  if (!text) return { from: null, to: null };
  const m = text.match(ROUTE_RE);
  if (!m) return { from: null, to: null };
  return { from: normalizePrimaryCity(m[1]), to: normalizePrimaryCity(m[2]) };
}

function extractTransportType(text) {
  if (!text) return null;
  const m = text.match(TRANSPORT_TYPE_RE);
  return m ? m[0] : null;
}

/**
 * Extract canonical fields from a single invoice input.
 * Layers: preParsed > rawText > emailSubject > fileName > emailBody
 */
export function extractFields(invoice) {
  const layers = [];
  const fields = {
    invoiceNumber: null,
    invoiceType: null,
    invoiceDate: null,
    amount: null,
    taxAmount: null,
    totalAmount: null,
    currency: 'CNY',
    sellerName: null,
    buyerTitle: null,
    expenseCategory: null,
    tripDate: null,
    city: null,
    transportFrom: null,
    transportTo: null,
    transportType: null,
    isSupportingDoc: false,
  };

  // Layer 0: preParsed (highest priority)
  if (invoice.preParsed) {
    layers.push('preParsed');
    for (const [k, v] of Object.entries(invoice.preParsed)) {
      if (v !== null && v !== undefined && k in fields) {
        fields[k] = v;
      }
    }
  }

  // Combine text sources for extraction
  const allText = [invoice.rawText, invoice.emailSubject, invoice.fileName, invoice.emailBody]
    .filter(Boolean).join('\n');

  // Layer 1: rawText
  if (invoice.rawText) {
    layers.push('rawText');
  }
  // Layer 2: emailSubject
  if (invoice.emailSubject) {
    layers.push('emailSubject');
  }
  // Layer 3: fileName
  if (invoice.fileName) {
    layers.push('fileName');
  }
  // Layer 4: emailBody
  if (invoice.emailBody) {
    layers.push('emailBody');
  }

  // Fill missing fields from combined text
  if (!fields.invoiceType) {
    fields.invoiceType = detectInvoiceType(allText);
  }
  if (!fields.invoiceDate) {
    fields.invoiceDate = extractFirstDate(allText);
  }
  if (!fields.totalAmount && !fields.amount) {
    fields.totalAmount = extractFirstAmount(allText);
  }
  if (!fields.invoiceNumber) {
    fields.invoiceNumber = extractInvoiceNumber(allText);
  }
  if (!fields.sellerName) {
    fields.sellerName = extractSeller(allText);
  }
  if (!fields.city) {
    fields.city = extractCity(allText);
  }
  if (!fields.transportFrom || !fields.transportTo) {
    const route = extractRoute(allText);
    if (!fields.transportFrom && route.from) fields.transportFrom = route.from;
    if (!fields.transportTo && route.to) fields.transportTo = route.to;
  }
  if (!fields.transportType) {
    fields.transportType = extractTransportType(allText);
  }

  // Derive city from route endpoints if missing
  if (!fields.city && fields.transportTo) {
    fields.city = fields.transportTo;
  }

  // Expense category defaults to invoice type
  if (!fields.expenseCategory) {
    fields.expenseCategory = fields.invoiceType;
  }

  // tripDate defaults to invoiceDate
  if (!fields.tripDate) {
    fields.tripDate = fields.invoiceDate;
  }

  return { fields, layers };
}

// ─── Required Fields & Status Derivation ─────────────────────────────

function fieldPresent(fields, name) {
  const v = fields[name];
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

function hasRoute(fields) {
  return fieldPresent(fields, 'transportFrom') && fieldPresent(fields, 'transportTo');
}

export function isRequiredSetSatisfied(type, fields) {
  const t = type || 'other';
  const hasDate = fieldPresent(fields, 'invoiceDate');
  const hasTotal = fieldPresent(fields, 'totalAmount') || fieldPresent(fields, 'amount');
  const hasSeller = fieldPresent(fields, 'sellerName');
  switch (t) {
    case 'taxi':
      return hasDate && hasTotal && (hasRoute(fields) || fieldPresent(fields, 'city'));
    case 'railway':
    case 'flight':
      return hasDate && hasTotal && fieldPresent(fields, 'transportFrom') && fieldPresent(fields, 'transportTo');
    case 'hotel':
    case 'meal':
      return hasDate && hasTotal && hasSeller;
    case 'other':
    default:
      return hasDate && hasTotal && hasSeller && fieldPresent(fields, 'invoiceNumber');
  }
}

export function missingRequiredFields(type, fields) {
  const t = type || 'other';
  const missing = [];
  if (!fieldPresent(fields, 'invoiceDate')) missing.push('invoiceDate');
  if (!(fieldPresent(fields, 'totalAmount') || fieldPresent(fields, 'amount'))) missing.push('totalAmount');
  switch (t) {
    case 'taxi':
      if (!(hasRoute(fields) || fieldPresent(fields, 'city'))) missing.push('route_or_city');
      break;
    case 'railway':
    case 'flight':
      if (!fieldPresent(fields, 'transportFrom')) missing.push('transportFrom');
      if (!fieldPresent(fields, 'transportTo')) missing.push('transportTo');
      break;
    case 'hotel':
    case 'meal':
      if (!fieldPresent(fields, 'sellerName')) missing.push('sellerName');
      break;
    case 'other':
    default:
      if (!fieldPresent(fields, 'sellerName')) missing.push('sellerName');
      if (!fieldPresent(fields, 'invoiceNumber')) missing.push('invoiceNumber');
      break;
  }
  return missing;
}

const PARSED_CONFIDENCE_THRESHOLD = 0.5;

export function deriveStatus(type, fields, confidence) {
  const conf = confidence ?? 0;
  if (isRequiredSetSatisfied(type, fields) && conf >= PARSED_CONFIDENCE_THRESHOLD) {
    return 'parsed';
  }
  return 'need_confirm';
}

// ─── Policy Checking ─────────────────────────────────────────────────

/**
 * Run meal/hotel/rail policy checks for a single invoice against the snapshot.
 */
export function checkPolicy(invoice, employeeLevel, snapshot) {
  const checks = [];
  const { fields, id } = invoice;
  const type = fields.invoiceType || fields.expenseCategory;
  const amount = fields.totalAmount ?? fields.amount ?? 0;
  const city = fields.city || '';
  const cityTier = resolveCityTier(city, snapshot);
  const scope = 'domestic'; // default for now; extendable

  if (type === 'meal') {
    const rule = snapshot.rules.find(
      (r) => r.expenseType === 'meal' && r.employeeLevelCode === employeeLevel && r.destinationScope === scope
    );
    if (rule && rule.valueType === 'fixed_cap' && rule.defaultValue !== null) {
      if (amount > rule.defaultValue) {
        checks.push({
          invoiceId: id,
          ruleId: rule.ruleId,
          severity: 'warning',
          message: `餐费 ¥${amount} 超过日限额 ${rule.displayValue}（${rule.note}）`,
          details: { limit: rule.defaultValue, actual: amount, level: employeeLevel },
        });
      } else {
        checks.push({
          invoiceId: id,
          ruleId: rule.ruleId,
          severity: 'info',
          message: `餐费 ¥${amount} 在限额 ${rule.displayValue} 内`,
          details: { limit: rule.defaultValue, actual: amount },
        });
      }
    }
  }

  if (type === 'hotel') {
    const rule = snapshot.rules.find(
      (r) => r.expenseType === 'hotel' && r.employeeLevelCode === employeeLevel &&
             r.destinationScope === scope && (r.cityTier === cityTier || r.cityTier === '')
    );
    if (rule && rule.valueType === 'fixed_cap' && rule.defaultValue !== null) {
      if (amount > rule.defaultValue) {
        checks.push({
          invoiceId: id,
          ruleId: rule.ruleId,
          severity: 'warning',
          message: `住宿 ¥${amount} 超过 ${cityTier} 城市限额 ${rule.displayValue}（${rule.note}）`,
          details: { limit: rule.defaultValue, actual: amount, cityTier, city, level: employeeLevel },
        });
      } else {
        checks.push({
          invoiceId: id,
          ruleId: rule.ruleId,
          severity: 'info',
          message: `住宿 ¥${amount} 在 ${cityTier} 城市限额 ${rule.displayValue} 内`,
          details: { limit: rule.defaultValue, actual: amount, cityTier },
        });
      }
    }
    // Water bill requirement: > ¥300 must have supporting doc
    if (amount > 300) {
      checks.push({
        invoiceId: id,
        ruleId: 'hotel-water-bill-required',
        severity: 'warning',
        message: `住宿单晚 > ¥300，请确认是否附有酒店水单`,
        details: { amount },
      });
    }
  }

  if (type === 'railway') {
    const rule = snapshot.rules.find(
      (r) => r.expenseType === 'rail' && r.employeeLevelCode === employeeLevel && r.destinationScope === scope
    );
    if (rule && rule.valueType === 'class' && fields.transportType) {
      const allowed = rule.displayValue;
      const actual = fields.transportType;
      const classOrder = ['二等座', '一等座', '商务座'];
      const allowedIdx = classOrder.indexOf(allowed);
      const actualIdx = classOrder.indexOf(actual);
      if (actualIdx > allowedIdx && allowedIdx >= 0) {
        checks.push({
          invoiceId: id,
          ruleId: rule.ruleId,
          severity: 'warning',
          message: `铁路座席 ${actual} 超过标准 ${allowed}`,
          details: { allowed, actual, level: employeeLevel },
        });
      }
    }
  }

  return checks;
}

// ─── Duplicate Detection ─────────────────────────────────────────────

/**
 * Detect suspected duplicates by matching invoiceNumber + amount + date.
 * Returns an array of { ids: [id1, id2, ...], reason } groups.
 */
function detectSuspectedDuplicates(results) {
  const groups = new Map(); // key -> [ids]
  for (const r of results) {
    const num = r.fields.invoiceNumber || '';
    const amt = r.fields.totalAmount ?? r.fields.amount ?? '';
    const date = r.fields.invoiceDate || '';
    // Only flag if we have at least 2 of the 3 key fields
    const presentCount = [num, amt, date].filter((v) => v !== '' && v !== null).length;
    if (presentCount < 2) continue;
    const key = `${num}|${amt}|${date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.id);
  }
  const duplicates = [];
  for (const [key, ids] of groups.entries()) {
    if (ids.length > 1) {
      const [num, amt, date] = key.split('|');
      duplicates.push({
        ids,
        reason: `疑似重复：发票号=${num || '?'} 金额=${amt || '?'} 日期=${date || '?'}`,
      });
    }
  }
  return duplicates;
}

// ─── Structured Review Questions ─────────────────────────────────────

/**
 * Generate structured ReviewQuestion objects for every warning and need_confirm item.
 * No warning is auto-exempted — every one requires explicit user confirmation.
 * §6.8.4: aggregated over-limit groups produce ONE question per group with settlement options.
 */
function generateStructuredReviewQuestions(results, policyChecks, duplicates, aggregation) {
  const questions = [];
  let qIdx = 0;

  // 1. Questions for need_confirm status items
  for (const item of results) {
    if (item.status === 'need_confirm') {
      qIdx++;
      questions.push({
        questionId: `rq_${qIdx}`,
        invoiceId: item.id,
        sourceRuleId: 'field_completeness',
        question: item.missingFields.length > 0
          ? `发票 ${item.id} 缺少必填字段（${item.missingFields.join(', ')}），请确认：豁免检查、手动补充信息，还是保留当前状态？`
          : `发票 ${item.id} 信息置信度不足，请确认：豁免检查、调整字段值，还是保留当前状态？`,
        availableActions: ['exempt', 'provide_info', 'keep', 'defer'],
        context: { missingFields: item.missingFields, confidence: item.confidence },
      });
    }
  }

  // 2. §6.8.4: Questions for aggregated over-limit groups (one per group, not per invoice)
  const handledGroupKeys = new Set();
  if (aggregation && aggregation.groups) {
    for (const group of aggregation.groups) {
      if (group.exceedAmount > 0) {
        qIdx++;
        const categoryLabel = group.category === 'meal' ? '餐费' : group.category === 'hotel' ? '住宿' : group.category;
        handledGroupKeys.add(group.groupKey);
        questions.push({
          questionId: `rq_${qIdx}`,
          invoiceId: group.invoiceIds[0],
          sourceRuleId: group.ruleId || `${group.category}_daily_limit`,
          question: `${group.date} ${categoryLabel}合计 ¥${group.actualAmount.toFixed(2)} 超过日限额 ¥${(group.standardAmount || 0).toFixed(2)}（超出 ¥${group.exceedAmount.toFixed(2)}）。选择：按标准封顶(keep)、按实际报销并说明原因(exempt+reason)、调整金额(adjust)、暂缓(defer)？`,
          availableActions: ['exempt', 'adjust', 'keep', 'defer'],
          context: {
            aggregateGroupKey: group.groupKey,
            category: group.category,
            date: group.date,
            invoiceIds: group.invoiceIds,
            actualAmount: group.actualAmount,
            standardAmount: group.standardAmount,
            exceedAmount: group.exceedAmount,
            defaultReimbursable: group.reimbursableAmount,
            settlementOptions: ['cap_to_standard', 'claim_actual_with_reason'],
            amountImpact: {
              cap_to_standard: group.standardAmount,
              claim_actual_with_reason: group.actualAmount,
            },
          },
        });
      }
    }

    // Questions for missing-date limited items
    for (const r of (aggregation.missingDateItems || [])) {
      qIdx++;
      const type = r.fields.invoiceType || r.fields.expenseCategory || 'other';
      const categoryLabel = type === 'meal' ? '餐费' : type === 'hotel' ? '住宿' : type;
      questions.push({
        questionId: `rq_${qIdx}`,
        invoiceId: r.id,
        sourceRuleId: 'missing_date_for_aggregation',
        question: `${categoryLabel}发票 ${r.id} 缺少日期，无法按日聚合政策判断。请补充日期或豁免检查。`,
        availableActions: ['provide_info', 'exempt', 'keep', 'defer'],
        context: { missingFields: ['tripDate', 'invoiceDate'], category: type },
      });
    }
  }

  // 3. Questions for policy warnings NOT already covered by aggregation groups
  for (const check of policyChecks) {
    if (check.severity === 'warning') {
      // Skip if this warning is for a limited category daily-limit already handled by aggregation
      if (aggregation && aggregation.groups) {
        const item = results.find(r => r.id === check.invoiceId);
        const type = item?.fields?.invoiceType || item?.fields?.expenseCategory || '';
        if (LIMITED_CATEGORIES.includes(type)) {
          const date = item?.fields?.tripDate || item?.fields?.invoiceDate || '';
          const gKey = `${date}|${type}`;
          // Only skip if the ruleId matches the group's ruleId (i.e., same daily-limit rule)
          const matchingGroup = aggregation.groups.find(g => g.groupKey === gKey && g.ruleId === check.ruleId);
          if (matchingGroup && handledGroupKeys.has(gKey)) continue;
        }
      }

      qIdx++;
      questions.push({
        questionId: `rq_${qIdx}`,
        invoiceId: check.invoiceId,
        sourceRuleId: check.ruleId,
        question: `${check.message} — 请确认：申请豁免、调整金额/选项，还是保留原值？`,
        availableActions: ['exempt', 'adjust', 'keep', 'defer'],
        context: check.details || {},
      });
    }
  }

  // 4. Questions for suspected duplicates
  for (const dup of duplicates) {
    qIdx++;
    questions.push({
      questionId: `rq_${qIdx}`,
      invoiceId: dup.ids[0],
      sourceRuleId: 'duplicate_detection',
      question: `${dup.reason}（涉及: ${dup.ids.join(', ')}）— 请确认：保留全部、移除重复项，还是标记为非重复？`,
      availableActions: ['keep', 'adjust', 'exempt', 'defer'],
      context: { duplicateGroup: dup.ids, reason: dup.reason },
    });
  }

  return questions;
}

// ─── Date-Based Aggregation (§6.8.4) ─────────────────────────────────

/**
 * Categories that are subject to per-day aggregation and capping.
 */
const LIMITED_CATEGORIES = ['meal', 'hotel'];

/**
 * Aggregate invoices by (tripDate || invoiceDate, category) for limited categories.
 * Returns aggregated groups and per-ticket rows for non-limited categories.
 */
function aggregateByDateCategory(results, employeeLevel, snapshot) {
  const groups = []; // { groupKey, category, date, invoiceIds, actualAmount, standardAmount, exceedAmount, reimbursableAmount, settlement, reason }
  const perTicketRows = []; // non-limited items

  // Build map: key -> [invoiceResult]
  const dateMap = new Map(); // "date|category" -> [result]
  const missingDateItems = [];

  for (const r of results) {
    const type = r.fields.invoiceType || r.fields.expenseCategory || 'other';
    if (!LIMITED_CATEGORIES.includes(type)) {
      perTicketRows.push(r);
      continue;
    }
    const date = r.fields.tripDate || r.fields.invoiceDate || null;
    if (!date) {
      // Missing date - cannot aggregate, must produce a traceable question
      missingDateItems.push(r);
      continue;
    }
    const key = `${date}|${type}`;
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key).push(r);
  }

  // Build aggregated groups
  for (const [key, items] of dateMap.entries()) {
    const [date, category] = key.split('|');
    const actualAmount = items.reduce((s, r) => s + (r.fields.totalAmount ?? r.fields.amount ?? 0), 0);
    const invoiceIds = items.map(r => r.id);

    // Resolve standard from policy
    const scope = 'domestic';
    let standardAmount = null;
    let rule = null;

    if (category === 'meal') {
      rule = snapshot.rules.find(
        r => r.expenseType === 'meal' && r.employeeLevelCode === employeeLevel && r.destinationScope === scope
      );
    } else if (category === 'hotel') {
      // For hotel, use the city from the first item with a city
      const city = items.find(i => i.fields.city)?.fields.city || '';
      const cityTier = resolveCityTier(city, snapshot);
      rule = snapshot.rules.find(
        r => r.expenseType === 'hotel' && r.employeeLevelCode === employeeLevel &&
             r.destinationScope === scope && (r.cityTier === cityTier || r.cityTier === '')
      );
    }

    if (rule && rule.valueType === 'fixed_cap' && rule.defaultValue !== null) {
      standardAmount = rule.defaultValue;
    }

    const exceedAmount = standardAmount !== null && actualAmount > standardAmount
      ? actualAmount - standardAmount : 0;

    // Default settlement: cap_to_standard if exceeding, otherwise actual is within limit
    const defaultReimbursable = standardAmount !== null && actualAmount > standardAmount
      ? standardAmount : actualAmount;

    groups.push({
      groupKey: key,
      category,
      date,
      invoiceIds,
      actualAmount,
      standardAmount,
      exceedAmount,
      reimbursableAmount: defaultReimbursable,
      settlement: exceedAmount > 0 ? 'cap_to_standard' : null,
      reason: null,
      ruleId: rule?.ruleId || null,
    });
  }

  // Missing-date items get their own special group per item (traceable, not merged)
  for (const r of missingDateItems) {
    const type = r.fields.invoiceType || r.fields.expenseCategory || 'other';
    const amt = r.fields.totalAmount ?? r.fields.amount ?? 0;
    groups.push({
      groupKey: `_missing_date_${r.id}|${type}`,
      category: type,
      date: null,
      invoiceIds: [r.id],
      actualAmount: amt,
      standardAmount: null,
      exceedAmount: 0,
      reimbursableAmount: amt,
      settlement: null,
      reason: null,
      ruleId: null,
    });
  }

  return { groups, perTicketRows, missingDateItems };
}

/**
 * Apply decisions to aggregated groups:
 * - keep → cap_to_standard (reimbursableAmount = standardAmount)
 * - exempt + reason → claim_actual_with_reason (reimbursableAmount = actualAmount)
 * - adjust → recompute with patched amounts
 * - defer → cap_to_standard (conservative, pending)
 * No valid reason → cannot claim actual.
 */
function applySettlementDecisions(groups, decisions, reviewQuestions) {
  if (!decisions || !Array.isArray(decisions)) return groups;

  for (const group of groups) {
    if (!group.exceedAmount || group.exceedAmount <= 0) continue;

    // Find relevant decision(s) for this group's rule
    const relevantQuestions = reviewQuestions.filter(q =>
      q.context?.aggregateGroupKey === group.groupKey
    );
    for (const rq of relevantQuestions) {
      const decision = decisions.find(d => d.questionId === rq.questionId);
      if (!decision) continue;

      if (decision.action === 'exempt' && decision.reason && decision.reason.trim().length > 0) {
        // claim_actual_with_reason
        group.settlement = 'claim_actual_with_reason';
        group.reason = decision.reason;
        group.reimbursableAmount = group.actualAmount;
      } else if (decision.action === 'keep') {
        // cap_to_standard (explicit)
        group.settlement = 'cap_to_standard';
        group.reason = null;
        group.reimbursableAmount = group.standardAmount ?? group.actualAmount;
      } else if (decision.action === 'defer') {
        // Conservative: cap_to_standard, mark as pending
        group.settlement = 'cap_to_standard';
        group.reason = null;
        group.reimbursableAmount = group.standardAmount ?? group.actualAmount;
      } else if (decision.action === 'adjust' && decision.fieldPatch) {
        // Recompute with patched amount
        if (decision.fieldPatch.totalAmount !== undefined) {
          group.actualAmount = Number(decision.fieldPatch.totalAmount);
          group.exceedAmount = group.standardAmount !== null && group.actualAmount > group.standardAmount
            ? group.actualAmount - group.standardAmount : 0;
          group.reimbursableAmount = group.exceedAmount > 0
            ? group.standardAmount : group.actualAmount;
          group.settlement = group.exceedAmount > 0 ? 'cap_to_standard' : null;
        }
      }
    }
  }
  return groups;
}

/**
 * Compute totals from aggregated groups and per-ticket rows.
 */
function computeTotals(groups, perTicketRows) {
  const actualTotal = groups.reduce((s, g) => s + g.actualAmount, 0)
    + perTicketRows.reduce((s, r) => s + (r.fields.totalAmount ?? r.fields.amount ?? 0), 0);
  const reimbursableTotal = groups.reduce((s, g) => s + g.reimbursableAmount, 0)
    + perTicketRows.reduce((s, r) => s + (r.fields.totalAmount ?? r.fields.amount ?? 0), 0);
  return { actualTotal, reimbursableTotal };
}

// ─── Output Generators ───────────────────────────────────────────────

function generateReimbursementDraft(employee, trip, results, aggregation) {
  const { actualTotal, reimbursableTotal } = computeTotals(
    aggregation.groups, aggregation.perTicketRows
  );
  return {
    employee,
    trip: trip || null,
    items: results,
    totalAmount: actualTotal,
    reimbursableAmount: reimbursableTotal,
    aggregation: {
      groups: aggregation.groups,
      perTicketRows: aggregation.perTicketRows.map(r => r.id),
    },
    generatedAt: new Date().toISOString(),
  };
}

function generatePolicyReport(employee, allChecks) {
  const warnings = allChecks.filter((c) => c.severity === 'warning').length;
  const errors = allChecks.filter((c) => c.severity === 'error').length;
  const passed = allChecks.filter((c) => c.severity === 'info').length;
  return {
    employee,
    checks: allChecks,
    summary: { total: allChecks.length, warnings, errors, passed },
    generatedAt: new Date().toISOString(),
  };
}

function generateTemplateInput(employee, results, aggregation, trip) {
  const CONTRACT_VERSION = '1.0.0';
  const rows = [];

  // Limited categories: one row per aggregated group
  for (const group of aggregation.groups) {
    const label = group.category === 'meal' ? '餐费' : group.category === 'hotel' ? '住宿' : group.category;
    let description = label;
    if (group.exceedAmount > 0) {
      if (group.settlement === 'claim_actual_with_reason') {
        description = `${label}·超标实报:${group.reason || ''}`;
      } else {
        description = `${label}·按标准`;
      }
    }
    rows.push({
      date: group.date || '',
      city: '',
      purpose: description,
      category: group.category,
      amount: group.reimbursableAmount,
      actualAmount: group.actualAmount,
      reimbursableAmount: group.reimbursableAmount,
      standardAmount: group.standardAmount,
      exceedAmount: group.exceedAmount,
      settlement: group.settlement,
      reason: group.reason,
      invoiceIds: group.invoiceIds,
      currency: 'CNY',
      rowType: 'aggregated',
    });
  }

  // Non-limited: per-ticket rows
  for (const r of aggregation.perTicketRows) {
    const amt = r.fields.totalAmount ?? r.fields.amount ?? 0;
    rows.push({
      date: r.fields.tripDate || r.fields.invoiceDate || '',
      city: r.fields.city || '',
      purpose: r.fields.expenseCategory || '',
      category: r.fields.invoiceType || 'other',
      amount: amt,
      actualAmount: amt,
      reimbursableAmount: amt,
      standardAmount: null,
      exceedAmount: 0,
      settlement: null,
      reason: null,
      invoiceIds: [r.id],
      currency: r.fields.currency || 'CNY',
      rowType: 'per_ticket',
    });
  }

  const { actualTotal, reimbursableTotal } = computeTotals(
    aggregation.groups, aggregation.perTicketRows
  );

  return {
    contractVersion: CONTRACT_VERSION,
    employee,
    trip: trip || null,
    rows,
    totalAmount: actualTotal,
    reimbursableAmount: reimbursableTotal,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Host Contract (§6.8.4) ───────────────────────────────────────────

/**
 * Generate host-contract.json: a versioned logical contract describing the data
 * structure that the host should use to render the final Excel/document.
 * Contains ONLY logical field definitions and semantics.
 * NEVER contains: physical template files, sheet names, cell coordinates, formulas, OOXML, absolute paths, or credentials.
 */
function generateHostContract(employee, aggregation, policyPackVersion) {
  const HOST_CONTRACT_VERSION = '1.0.0';

  return {
    contractVersion: HOST_CONTRACT_VERSION,
    policyPackVersion,
    description: 'Logical template contract for expense reimbursement rendering. Host adapter maps these fields to its authorized template. No physical template, sheet names, position coordinates, computed expressions, or proprietary markup are included.',
    generatedAt: new Date().toISOString(),
    header: {
      description: 'Employee and trip header fields for the reimbursement document',
      fields: [
        { name: 'employeeName', type: 'string', semantic: '报销人姓名' },
        { name: 'employeeId', type: 'string', semantic: '工号' },
        { name: 'department', type: 'string', semantic: '部门' },
        { name: 'costCenter', type: 'string', semantic: '成本中心' },
        { name: 'tripDestination', type: 'string', semantic: '出差目的地' },
        { name: 'tripPurpose', type: 'string', semantic: '出差事由' },
        { name: 'tripStartDate', type: 'date', semantic: '出差开始日期 (YYYY-MM-DD)' },
        { name: 'tripEndDate', type: 'date', semantic: '出差结束日期 (YYYY-MM-DD)' },
        { name: 'totalActualAmount', type: 'number', semantic: '实际总金额' },
        { name: 'totalReimbursableAmount', type: 'number', semantic: '可报销总额' },
        { name: 'currency', type: 'string', semantic: '币种 (默认 CNY)' },
        { name: 'generatedAt', type: 'datetime', semantic: '生成时间 (ISO-8601)' },
      ],
    },
    detailRows: {
      description: 'Detail/render rows. Limited categories (meal, hotel) are aggregated by date. Transport and other categories are per-ticket.',
      rowTypes: [
        {
          type: 'aggregated',
          description: 'One row per (date, category) for limited categories. Represents sum of multiple invoices.',
          fields: [
            { name: 'date', type: 'date', semantic: '消费日期 (YYYY-MM-DD)' },
            { name: 'category', type: 'string', semantic: '费用类别 (meal/hotel)' },
            { name: 'purpose', type: 'string', semantic: '说明（含超标结算描述）' },
            { name: 'actualAmount', type: 'number', semantic: '实际合计金额' },
            { name: 'standardAmount', type: 'number|null', semantic: '该级别该日标准限额' },
            { name: 'reimbursableAmount', type: 'number', semantic: '可报销金额（封顶或实际）' },
            { name: 'exceedAmount', type: 'number', semantic: '超标金额' },
            { name: 'settlement', type: 'string|null', semantic: '结算方式: cap_to_standard / claim_actual_with_reason / null' },
            { name: 'reason', type: 'string|null', semantic: '按实报销原因（仅 claim_actual_with_reason 时）' },
            { name: 'invoiceIds', type: 'string[]', semantic: '关联发票 ID 列表' },
            { name: 'currency', type: 'string', semantic: '币种' },
          ],
        },
        {
          type: 'per_ticket',
          description: 'One row per invoice for non-limited categories (transport, other).',
          fields: [
            { name: 'date', type: 'date', semantic: '消费日期 (YYYY-MM-DD)' },
            { name: 'city', type: 'string', semantic: '城市' },
            { name: 'category', type: 'string', semantic: '费用类别 (railway/taxi/flight/other)' },
            { name: 'purpose', type: 'string', semantic: '说明/费用类别描述' },
            { name: 'actualAmount', type: 'number', semantic: '发票金额' },
            { name: 'reimbursableAmount', type: 'number', semantic: '可报销金额（非限额类等于 actualAmount）' },
            { name: 'invoiceIds', type: 'string[]', semantic: '关联发票 ID（单元素）' },
            { name: 'currency', type: 'string', semantic: '币种' },
          ],
        },
      ],
    },
    constraints: [
      'Host MUST NOT assume any physical template structure from this contract.',
      'Host is responsible for mapping logical fields to its authorized Excel/document template.',
      'This contract defines semantics only; rendering, formatting, and layout are host responsibilities.',
      'No absolute file paths, credentials, or template binaries are included or implied.',
    ],
  };
}

function generateReviewQuestions(results, policyChecks, duplicates) {
  const lines = ['# Review Questions\n'];
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push('> **注意**: 所有警告项均需用户明确确认（豁免、调整或保留），系统绝不自动豁免。\n');

  const needConfirm = results.filter((r) => r.status === 'need_confirm');
  if (needConfirm.length > 0) {
    lines.push('## Items Needing Confirmation\n');
    for (const item of needConfirm) {
      lines.push(`### Invoice ${item.id}`);
      lines.push(`- Status: \`need_confirm\``);
      lines.push(`- Missing fields: ${item.missingFields.join(', ') || 'none'}`);
      lines.push(`- Type: ${item.fields.invoiceType || 'unknown'}`);
      lines.push(`- Amount: ¥${item.fields.totalAmount ?? item.fields.amount ?? '?'}`);
      lines.push(`- **需用户确认**: 豁免检查 / 手动补充信息 / 保留当前状态`);
      lines.push('');
    }
  }

  const warnings = policyChecks.filter((c) => c.severity === 'warning');
  if (warnings.length > 0) {
    lines.push('## Policy Warnings (需逐项确认)\n');
    for (const w of warnings) {
      lines.push(`- **[${w.ruleId}]** Invoice ${w.invoiceId}: ${w.message}`);
      lines.push(`  - **需用户确认**: 申请豁免 / 调整金额或选项 / 保留原值`);
    }
    lines.push('');
  }

  if (duplicates && duplicates.length > 0) {
    lines.push('## Suspected Duplicates (需确认)\n');
    for (const dup of duplicates) {
      lines.push(`- ${dup.reason}（涉及: ${dup.ids.join(', ')}）`);
      lines.push(`  - **需用户确认**: 保留全部 / 移除重复项 / 标记为非重复`);
    }
    lines.push('');
  }

  if (needConfirm.length === 0 && warnings.length === 0 && (!duplicates || duplicates.length === 0)) {
    lines.push('All items passed. No questions to review.\n');
  }

  return lines.join('\n');
}

function generateAuditEntries(input, results, policyChecks) {
  const entries = [];
  const ts = new Date().toISOString();

  entries.push({ timestamp: ts, action: 'session_start', details: { employeeName: input.employee.name, invoiceCount: input.invoices.length } });

  for (const r of results) {
    entries.push({ timestamp: ts, action: 'extraction_complete', invoiceId: r.id, details: { status: r.status, layers: r.extractionLayers } });
  }

  for (const c of policyChecks) {
    entries.push({ timestamp: ts, action: 'policy_check', invoiceId: c.invoiceId, details: { ruleId: c.ruleId, severity: c.severity, message: c.message } });
  }

  entries.push({ timestamp: ts, action: 'session_end', details: { totalResults: results.length, totalChecks: policyChecks.length } });

  return entries;
}

// ─── Summary & Decision Template Generators (§6.8.3) ─────────────────

/**
 * Generate a human-readable summary.md from the processing results.
 */
function generateSummaryMd(input, draft, report, policyFindings, reviewQuestions, duplicates, decisionsApplied, recovery = {}, aggregation = null) {
  const lines = [];
  lines.push('# Reimbursement Processing Summary\n');
  lines.push(`**Employee**: ${input.employee.name} (${input.employee.employeeId || 'N/A'})`);
  lines.push(`**Department**: ${input.employee.department || 'N/A'}`);
  lines.push(`**Level**: ${input.employee.level}`);
  if (input.trip) {
    lines.push(`**Trip**: ${input.trip.destination || 'N/A'} (${input.trip.startDate} → ${input.trip.endDate})`);
    if (input.trip.purpose) lines.push(`**Purpose**: ${input.trip.purpose}`);
  }
  lines.push(`**Generated**: ${new Date().toISOString()}\n`);

  lines.push('## Invoice Summary\n');
  lines.push(`| # | ID | Type | Amount | Status |`);
  lines.push(`|---|---|---|---|---|`);
  draft.items.forEach((item, i) => {
    const amt = item.fields.totalAmount ?? item.fields.amount ?? 0;
    lines.push(`| ${i + 1} | ${item.id} | ${item.fields.invoiceType || 'other'} | ¥${amt.toFixed(2)} | ${item.status} |`);
  });
  lines.push(`\n**Actual Total**: ¥${draft.totalAmount.toFixed(2)} (${draft.items.length} invoices)`);
  lines.push(`**Reimbursable Total**: ¥${draft.reimbursableAmount.toFixed(2)}\n`);

  // Aggregation summary
  if (aggregation && aggregation.groups.length > 0) {
    const exceedingGroups = aggregation.groups.filter(g => g.exceedAmount > 0);
    if (exceedingGroups.length > 0) {
      lines.push('## Over-limit Aggregation Groups\n');
      lines.push('| Date | Category | Actual | Standard | Exceed | Reimbursable | Settlement |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const g of exceedingGroups) {
        const cat = g.category === 'meal' ? '餐费' : g.category === 'hotel' ? '住宿' : g.category;
        lines.push(`| ${g.date || 'N/A'} | ${cat} | ¥${g.actualAmount.toFixed(2)} | ¥${(g.standardAmount || 0).toFixed(2)} | ¥${g.exceedAmount.toFixed(2)} | ¥${g.reimbursableAmount.toFixed(2)} | ${g.settlement || '-'} |`);
      }
      lines.push('');
    }
  }

  // Policy summary
  lines.push('## Policy Compliance\n');
  lines.push(`- Total checks: ${report.summary.total}`);
  lines.push(`- Passed: ${report.summary.passed}`);
  lines.push(`- Warnings: ${report.summary.warnings}`);
  lines.push(`- Errors: ${report.summary.errors}`);
  if (report.summary.warnings > 0) {
    lines.push('\n### Warnings (require user confirmation)\n');
    for (const f of policyFindings.filter(f => f.severity === 'warning')) {
      lines.push(`- **${f.invoiceId}** [${f.ruleId}]: ${f.message}`);
    }
  }
  lines.push('');

  // Duplicates
  if (duplicates.length > 0) {
    lines.push('## Suspected Duplicates\n');
    for (const d of duplicates) {
      lines.push(`- ${d.reason} → IDs: ${d.ids.join(', ')}`);
    }
    lines.push('');
  }

  // Pending review
  const pending = reviewQuestions.filter(q => !decisionsApplied || !decisionsApplied.find(d => d.questionId === q.questionId));
  if (pending.length > 0) {
    lines.push('## Pending Review Questions\n');
    lines.push(`${pending.length} question(s) require explicit user decision. See \`review-questions.json\` or use \`--decisions\` flag.\n`);
  }

  // Decisions applied
  if (decisionsApplied && decisionsApplied.length > 0) {
    lines.push('## Decisions Applied\n');
    for (const d of decisionsApplied) {
      lines.push(`- **${d.questionId}**: ${d.action}${d.reason ? ' — ' + d.reason : ''}`);
    }
    lines.push('');
  }

  lines.push('## Recovery\n');
  lines.push(`- Input file: \`${recovery.inputFile || 'input.json'}\``);
  lines.push(`- Decisions file: ${recovery.decisionsFile ? `\`${recovery.decisionsFile}\`` : '`none` (copy `review-decisions.template.json` when ready)'}`);
  lines.push(`- Output directory: \`${recovery.outputDirectory || 'output'}\``);
  lines.push('- Re-run this input with `--decisions <file>` after recording explicit decisions.\n');

  // Host responsibility note
  lines.push('---\n');
  lines.push('> **Note**: This portable skill processes JSON text input only. The host system is responsible for:');
  lines.push('> PDF/OFD/XML parsing, controlled Excel rendering, and file storage management.\n');

  return lines.join('\n');
}

/**
 * Generate a review-decisions.template.json that users can fill in and pass back via --decisions.
 */
function generateDecisionTemplate(reviewQuestions) {
  return reviewQuestions.map(q => ({
    questionId: q.questionId,
    invoiceId: q.invoiceId,
    sourceRuleId: q.sourceRuleId,
    question: q.question,
    availableActions: q.availableActions,
    // --- User fills below ---
    action: '',       // One of availableActions
    reason: '',       // Required if action === 'exempt'
    fieldPatch: {},   // Required if action === 'adjust' or 'provide_info', keys from allowed list
  }));
}

// ─── Main Processing Pipeline ────────────────────────────────────────

/**
 * Process a PortableSkillInput and return all output artifacts.
 * This is the main exported function for programmatic use.
 * @param {object} input - PortableSkillInput
 * @param {object} [options] - { decisions?: array }
 */
export async function processInput(input, options = {}) {
  const snapshot = await loadPolicyRules();
  const employeeLevel = input.employee.level || 'staff';
  const decisions = options.decisions || null;

  // 1. Extract fields for each invoice
  const results = input.invoices.map((inv, idx) => {
    const id = inv.id || `inv_${idx + 1}`;
    const { fields, layers } = extractFields(inv);

    // Normalize city
    if (fields.city) fields.city = normalizePrimaryCity(fields.city);
    if (fields.transportFrom) fields.transportFrom = normalizePrimaryCity(fields.transportFrom);
    if (fields.transportTo) fields.transportTo = normalizePrimaryCity(fields.transportTo);

    // Compute confidence heuristic based on layers
    const confidence = layers.includes('preParsed') ? 0.9
      : layers.includes('rawText') ? 0.7
      : layers.length > 0 ? 0.5
      : 0.1;

    const missing = missingRequiredFields(fields.invoiceType, fields);
    const status = deriveStatus(fields.invoiceType, fields, confidence);

    return { id, status, fields, missingFields: missing, confidence, extractionLayers: layers };
  });

  // 2. Duplicate detection — mark suspected duplicates as need_confirm
  const duplicates = detectSuspectedDuplicates(results);
  for (const dup of duplicates) {
    for (const dupId of dup.ids) {
      const item = results.find((r) => r.id === dupId);
      if (item && item.status !== 'need_confirm') {
        item.status = 'need_confirm';
        if (!item.missingFields.includes('suspected_duplicate')) {
          item.missingFields.push('suspected_duplicate');
        }
      }
      // Mark for later reference after decision patching
      if (item) item._wasDuplicate = true;
    }
  }

  // 3. Policy checks
  let allChecks = [];
  for (const r of results) {
    const checks = checkPolicy(r, employeeLevel, snapshot);
    allChecks.push(...checks);
  }

  // 4. Convert policy checks to PolicyFinding format (requiresConfirmation for warnings)
  let policyFindings = allChecks.map((c) => ({
    invoiceId: c.invoiceId,
    ruleId: c.ruleId,
    severity: c.severity,
    message: c.message,
    requiresConfirmation: c.severity === 'warning',
    details: c.details || {},
  }));

  // 5. §6.8.4: Date-based aggregation for limited categories
  let aggregation = aggregateByDateCategory(results, employeeLevel, snapshot);

  // 6. Generate structured review questions (never auto-exempt) — with aggregation context
  let reviewQuestions = generateStructuredReviewQuestions(results, allChecks, duplicates, aggregation);

  // 7. Decision application (§6.8.3): validate and apply if provided
  let decisionValidation = null;
  let decisionAuditEntries = [];
  if (decisions && Array.isArray(decisions)) {
    decisionValidation = validateAllDecisions(decisions, reviewQuestions);
    if (decisionValidation.valid) {
      const applied = applyDecisions(decisions, results, reviewQuestions, snapshot, employeeLevel);
      decisionAuditEntries = applied.decisionAuditEntries;
      allChecks = applied.updatedChecks;

      // §6.8.4: Apply settlement decisions to aggregation groups
      aggregation.groups = applySettlementDecisions(aggregation.groups, decisions, reviewQuestions);

      // Re-aggregate after potential field patches (adjust may change amounts/dates)
      aggregation = aggregateByDateCategory(results, employeeLevel, snapshot);
      aggregation.groups = applySettlementDecisions(aggregation.groups, decisions, reviewQuestions);

      // Regenerate findings and questions after decisions
      policyFindings = allChecks.map((c) => ({
        invoiceId: c.invoiceId,
        ruleId: c.ruleId,
        severity: c.severity,
        message: c.message,
        requiresConfirmation: c.severity === 'warning',
        details: c.details || {},
      }));
      reviewQuestions = generateStructuredReviewQuestions(results, allChecks, duplicates, aggregation);
    }
  }

  // 8. Generate outputs
  const draft = generateReimbursementDraft(input.employee, input.trip, results, aggregation);
  const report = generatePolicyReport(input.employee, allChecks);
  const templateInput = generateTemplateInput(input.employee, results, aggregation, input.trip);
  const hostContract = generateHostContract(input.employee, aggregation, snapshot.version);
  const reviewMd = generateReviewQuestions(results, allChecks, duplicates);
  const auditEntries = generateAuditEntries(input, results, allChecks);
  const decisionTemplate = generateDecisionTemplate(reviewQuestions);
  const summaryMd = generateSummaryMd(input, draft, report, policyFindings, reviewQuestions, duplicates, decisions, options.recovery, aggregation);

  return {
    draft,
    report,
    templateInput,
    hostContract,
    reviewMd,
    auditEntries,
    policyFindings,
    reviewQuestions,
    duplicates,
    policyPackVersion: snapshot.version,
    decisionValidation,
    decisionAuditEntries,
    decisionTemplate,
    summaryMd,
    aggregation,
  };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────

/**
 * --init <path>: Generate a sample input JSON at the given path.
 */
async function cliInit(targetPath) {
  const sample = {
    employee: {
      name: '',
      employeeId: '',
      department: '',
      position: '',
      costCenter: '',
      level: 'staff',
    },
    trip: {
      startDate: '',
      endDate: '',
      destination: '',
      purpose: '',
    },
    invoices: [
      {
        id: 'inv_1',
        rawText: '',
        emailSubject: '',
        fileName: '',
        preParsed: {},
      },
    ],
  };
  const outPath = resolve(targetPath);
  await mkdir(dirname(outPath), { recursive: true });
  const content = JSON.stringify(sample, null, 2);
  await writeFile(outPath, content);
  console.log(`✓ Initialized sample input at: ${outPath}`);
  console.log(`  Edit the file, then run: node portable-core.mjs --input ${targetPath}`);
}

/**
 * --validate --input <path>: Validate input JSON without processing.
 */
async function cliValidate(inputPath) {
  const raw = await readFile(resolve(inputPath), 'utf-8');
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.error(`✗ Invalid JSON: ${e.message}`);
    process.exit(1);
  }

  const errors = [];
  if (!input.employee || typeof input.employee !== 'object') {
    errors.push('Missing or invalid "employee" object');
  } else {
    if (!input.employee.name) errors.push('employee.name is required');
    if (!input.employee.level) errors.push('employee.level is required');
    const validLevels = ['staff', 'manager', 'assistant_director', 'director', 'evp'];
    if (input.employee.level && !validLevels.includes(input.employee.level)) {
      errors.push(`employee.level must be one of: ${validLevels.join(', ')}`);
    }
  }
  if (!Array.isArray(input.invoices) || input.invoices.length === 0) {
    errors.push('Must have at least one invoice in "invoices" array');
  }
  if (input.trip) {
    if (input.trip.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.trip.startDate)) {
      errors.push('trip.startDate must be YYYY-MM-DD format');
    }
    if (input.trip.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.trip.endDate)) {
      errors.push('trip.endDate must be YYYY-MM-DD format');
    }
  }

  if (errors.length > 0) {
    console.error('✗ Input validation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log('✓ Input is valid');
  console.log(`  Employee: ${input.employee.name} (${input.employee.level})`);
  console.log(`  Invoices: ${input.invoices.length}`);
  if (input.trip) console.log(`  Trip: ${input.trip.destination || 'N/A'} (${input.trip.startDate} → ${input.trip.endDate})`);
}

async function cli() {
  const args = process.argv ? process.argv.slice(2) : [];

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
KONE Expense Reimbursement — Portable Core CLI (§6.8.3)

Usage:
  node portable-core.mjs --init <path>
  node portable-core.mjs --validate --input <input.json>
  node portable-core.mjs --input <input.json> [--output-dir <dir>] [--decisions <decisions.json>]

Commands:
  --init <path>        Generate a sample input JSON template at <path>
  --validate           Validate the input JSON (use with --input)

Options:
  --input, -i          Path to input JSON (PortableSkillInput schema)
  --output-dir, -o     Output directory (default: ./output)
  --decisions, -d      Path to decisions JSON (answers to review questions)
  --help, -h           Show this help

Decision JSON schema:
  [
    {
      "questionId": "rq_1",
      "action": "exempt|adjust|keep|provide_info|defer",
      "reason": "...",           // required if action=exempt
      "fieldPatch": { ... }      // required if action=adjust|provide_info
    }
  ]

Allowed fieldPatch keys:
  totalAmount, amount, invoiceDate, tripDate, city, transportFrom,
  transportTo, transportType, sellerName, invoiceNumber, invoiceType,
  expenseCategory

Outputs (written to output-dir):
  summary.md                 Human-readable processing summary
  reimbursement-draft.json   Extraction results + totals + aggregation
  policy-report.json         Policy compliance checks
  policy-findings.json       Structured policy findings (requiresConfirmation)
  review-questions.json      Structured review questions (never auto-exempt)
  review-questions.md        Human-readable review items
  review-decisions.template.json     Pre-filled template for user decisions
  template-input.json        Data for template filling (host renders Excel)
  host-contract.json         Versioned logical template contract (§6.8.4)
  audit.ndjson               Processing audit trail
  decision-log.json          Applied decisions audit (if --decisions used)
  manifest.json              Execution manifest: versions, hashes, timestamp

NOTE: This portable skill processes JSON/text only. The host is responsible for
PDF/OFD/XML parsing and controlled Excel rendering.
`);
    return;
  }

  // --init <path>
  const initIdx = args.indexOf('--init');
  if (initIdx >= 0) {
    const targetPath = args[initIdx + 1];
    if (!targetPath) {
      console.error('Error: --init requires a file path argument.');
      process.exit(1);
    }
    await cliInit(targetPath);
    return;
  }

  // Parse flags
  let inputPath = null;
  let outputDir = './output';
  let decisionsPath = null;
  let validateOnly = args.includes('--validate');

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--input' || args[i] === '-i') && args[i + 1]) {
      inputPath = args[++i];
    } else if ((args[i] === '--output-dir' || args[i] === '-o') && args[i + 1]) {
      outputDir = args[++i];
    } else if ((args[i] === '--decisions' || args[i] === '-d') && args[i + 1]) {
      decisionsPath = args[++i];
    }
  }

  if (!inputPath) {
    console.error('Error: --input is required. Use --help for usage.');
    process.exit(1);
  }

  // --validate --input <path>
  if (validateOnly) {
    await cliValidate(inputPath);
    return;
  }

  // Read input
  const inputRaw = await readFile(resolve(inputPath), 'utf-8');
  const input = JSON.parse(inputRaw);

  // Read decisions if provided
  let decisions = null;
  let decisionsRaw = null;
  if (decisionsPath) {
    decisionsRaw = await readFile(resolve(decisionsPath), 'utf-8');
    decisions = JSON.parse(decisionsRaw);
  }

  // Process with safe relative references for durable recovery guidance.
  const relativeFileRef = (candidate) => (
    candidate && candidate.startsWith('/') ? candidate.split('/').pop() : candidate
  );
  const recovery = {
    inputFile: relativeFileRef(inputPath),
    decisionsFile: relativeFileRef(decisionsPath),
    outputDirectory: relativeFileRef(outputDir) || 'output',
  };
  const result = await processInput(input, { decisions, recovery });

  const {
    draft, report, templateInput, hostContract, reviewMd, auditEntries,
    policyFindings, reviewQuestions, duplicates, policyPackVersion,
    decisionValidation, decisionAuditEntries, decisionTemplate, summaryMd,
  } = result;

  // If decisions were invalid, report and exit
  if (decisions && decisionValidation && !decisionValidation.valid) {
    console.error('✗ Decision validation failed:');
    for (const r of decisionValidation.results) {
      if (!r.valid) {
        console.error(`  [${r.questionId}]: ${r.errors.join('; ')}`);
      }
    }
    process.exit(1);
  }

  // Write outputs
  const outDir = resolve(outputDir);
  await mkdir(outDir, { recursive: true });

  const outputFiles = {};

  // summary.md
  await writeFile(join(outDir, 'summary.md'), summaryMd);
  outputFiles['summary.md'] = sha256(summaryMd);

  const draftJson = JSON.stringify(draft, null, 2);
  await writeFile(join(outDir, 'reimbursement-draft.json'), draftJson);
  outputFiles['reimbursement-draft.json'] = sha256(draftJson);

  const reportJson = JSON.stringify(report, null, 2);
  await writeFile(join(outDir, 'policy-report.json'), reportJson);
  outputFiles['policy-report.json'] = sha256(reportJson);

  await writeFile(join(outDir, 'review-questions.md'), reviewMd);
  outputFiles['review-questions.md'] = sha256(reviewMd);

  const templateJson = JSON.stringify(templateInput, null, 2);
  await writeFile(join(outDir, 'template-input.json'), templateJson);
  outputFiles['template-input.json'] = sha256(templateJson);

  const hostContractJson = JSON.stringify(hostContract, null, 2);
  await writeFile(join(outDir, 'host-contract.json'), hostContractJson);
  outputFiles['host-contract.json'] = sha256(hostContractJson);

  const ndjson = auditEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(join(outDir, 'audit.ndjson'), ndjson);
  outputFiles['audit.ndjson'] = sha256(ndjson);

  const findingsJson = JSON.stringify(policyFindings, null, 2);
  await writeFile(join(outDir, 'policy-findings.json'), findingsJson);
  outputFiles['policy-findings.json'] = sha256(findingsJson);

  const reviewQuestionsJson = JSON.stringify(reviewQuestions, null, 2);
  await writeFile(join(outDir, 'review-questions.json'), reviewQuestionsJson);
  outputFiles['review-questions.json'] = sha256(reviewQuestionsJson);

  // review-decisions.template.json
  const decisionTemplateJson = JSON.stringify(decisionTemplate, null, 2);
  await writeFile(join(outDir, 'review-decisions.template.json'), decisionTemplateJson);
  outputFiles['review-decisions.template.json'] = sha256(decisionTemplateJson);

  // decision-log.json (only if decisions were supplied)
  if (decisions && decisionValidation && decisionValidation.valid) {
    const decisionLog = {
      appliedAt: new Date().toISOString(),
      decisions,
      auditEntries: decisionAuditEntries,
      validationResults: decisionValidation.results,
    };
    const decisionLogJson = JSON.stringify(decisionLog, null, 2);
    await writeFile(join(outDir, 'decision-log.json'), decisionLogJson);
    outputFiles['decision-log.json'] = sha256(decisionLogJson);
  }

  // Build manifest.json (§6.8.2 tool snapshot contract)
  // Use relative paths only, no sensitive full paths
  const relativeInputPath = inputPath.startsWith('/') ? inputPath.split('/').pop() : inputPath;
  const inputHash = sha256(inputRaw);
  const manifestInputHashes = [{ filePath: relativeInputPath, sha256: inputHash }];
  if (decisionsRaw) {
    const relDecPath = decisionsPath.startsWith('/') ? decisionsPath.split('/').pop() : decisionsPath;
    manifestInputHashes.push({ filePath: relDecPath, sha256: sha256(decisionsRaw) });
  }

  const manifest = {
    skillVersion: '1.2.0',
    policyPackVersion,
    hostContractVersion: hostContract.contractVersion,
    templatePackVersion: null,
    generatedAt: new Date().toISOString(),
    inputHashes: manifestInputHashes,
    outputHashes: Object.entries(outputFiles).map(([filePath, hash]) => ({ filePath, sha256: hash })),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  await writeFile(join(outDir, 'manifest.json'), manifestJson);

  // Terminal output: clear, actionable
  console.log('');
  console.log(`✓ Output written to ${outDir}/`);
  console.log('');
  console.log('  Artifacts:');
  console.log(`    summary.md                  Human-readable summary`);
  console.log(`    reimbursement-draft.json    ${draft.items.length} invoices, total ¥${draft.totalAmount.toFixed(2)}`);
  console.log(`    policy-report.json          ${report.summary.total} checks, ${report.summary.warnings} warnings`);
  console.log(`    policy-findings.json        ${policyFindings.length} findings`);
  console.log(`    review-questions.json       ${reviewQuestions.length} questions`);
  console.log(`    review-questions.md         Human-readable review`);
  console.log(`    review-decisions.template.json      Pre-filled decision template`);
  console.log(`    template-input.json         For host Excel rendering`);
  console.log(`    host-contract.json          Logical template contract v${hostContract.contractVersion}`);
  console.log(`    audit.ndjson                ${auditEntries.length} entries`);
  if (decisions && decisionValidation && decisionValidation.valid) {
    console.log(`    decision-log.json           ${decisions.length} decisions applied`);
  }
  console.log(`    manifest.json               policyPack: ${policyPackVersion}`);
  console.log('');

  // Actionable next steps
  if (reviewQuestions.length > 0 && !decisions) {
    console.log(`  ⚠ ${reviewQuestions.length} review question(s) pending.`);
    console.log(`    → Fill review-decisions.template.json and re-run with --decisions review-decisions.template.json`);
  } else if (decisions && decisionValidation && decisionValidation.valid) {
    const remaining = reviewQuestions.length;
    if (remaining > 0) {
      console.log(`  ⚠ ${remaining} review question(s) still pending after decisions.`);
    } else {
      console.log(`  ✓ All review questions resolved.`);
    }
  }
  console.log('');
  console.log('  NOTE: Host owns PDF/OFD/XML parsing and controlled Excel rendering.');
  console.log('');
}

// Run CLI if invoked directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('portable-core.mjs') ||
  process.argv[1] === fileURLToPath(import.meta.url)
);

if (isMain) {
  cli().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
