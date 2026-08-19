/**
 * Mailbox Filler — IMAP incremental attachment downloader.
 *
 * Uses imapflow (already in package.json) to connect to IMAP, search for
 * invoice-related emails since a certain date / last UID, and download
 * attachments to the local inboxDir.
 *
 * Credentials come ONLY from environment variables (cfg.mailbox.passwordEnv).
 * State (lastUid, uidValidity) is persisted in the collector state file.
 */

import { writeFileSync, readFileSync, existsSync, createWriteStream, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

// ─── Constants ───────────────────────────────────────────────────────

const INVOICE_EXTENSIONS = new Set(['.pdf', '.ofd', '.xml', '.png', '.jpg', '.jpeg', '.zip']);

const DEFAULT_SUBJECT_FILTER = /发票|报销|invoice|receipt|电子客票|行程单/i;

// ─── Pure Functions (testable) ───────────────────────────────────────

/**
 * Compute a dedup key for a downloaded attachment at the mail level.
 * Combines UID + uidValidity + filename for uniqueness.
 */
export function mailDedupeKey(uid, uidValidity, filename) {
  return `${uidValidity}:${uid}:${filename}`;
}

/**
 * Determine if a filename looks like an invoice attachment.
 */
export function isInvoiceAttachment(filename) {
  if (!filename) return false;
  const ext = extname(filename).toLowerCase();
  return INVOICE_EXTENSIONS.has(ext);
}

/**
 * Calculate the "since" date based on sinceDays from today.
 */
export function computeSinceDate(sinceDays) {
  const d = new Date();
  d.setDate(d.getDate() - (sinceDays || 30));
  return d;
}

/**
 * Test if an email subject matches the invoice filter.
 */
export function matchesSubjectFilter(subject, customFilter) {
  if (!subject) return true; // If no subject, still process (attachment-based)
  const regex = customFilter ? new RegExp(customFilter, 'i') : DEFAULT_SUBJECT_FILTER;
  return regex.test(subject);
}

/**
 * Classify a connection error into a user-readable hint (Spec §6.8.6.11).
 * Pure function — testable without a live socket.
 *
 * @param {Error|{code?:string,message?:string}} err
 * @param {string} stage - 'tcp' | 'imap'
 * @returns {{code:string, hint:string}}
 */
export function classifyConnectError(err, stage = 'imap') {
  const code = (err && (err.code || err.responseCode)) || '';
  const msg = ((err && err.message) || '').toString();
  const lower = msg.toLowerCase();

  // DNS resolution failure (check before the generic blocking branch, since a
  // failed DNS lookup can surface during the TCP stage too)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || lower.includes('getaddrinfo')) {
    return {
      code: code || 'ENOTFOUND',
      hint: 'IMAP 服务器地址无法解析，请检查 mailbox.host 配置是否正确。',
    };
  }

  // Corporate network / proxy / SASE blocking outbound IMAP ports
  if (
    code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' || code === 'ECONNRESET' || stage === 'tcp' ||
    lower.includes('timeout') || lower.includes('timed out')
  ) {
    return {
      code: code || 'ETIMEDOUT',
      hint:
        '可能是公司安全策略（如 Prisma Access/SASE）拦截了外部邮箱端口（993/143）。' +
        '受控电脑换网络（含手机热点）通常也绕不过——流量仍走公司安全网关。' +
        '建议改用「本地文件夹」模式（无需邮箱），或换未纳管的个人设备，或联系 IT 放行。',
    };
  }

  // Authentication failure — never echo credentials
  if (
    lower.includes('auth') || lower.includes('login') ||
    lower.includes('invalid credentials') || lower.includes('password') ||
    code === 'AUTHENTICATIONFAILED'
  ) {
    return {
      code: code || 'AUTHENTICATIONFAILED',
      hint: '邮箱账号或 IMAP 授权码不正确（部分邮箱需使用“授权码”而非登录密码）。请核对后重试。',
    };
  }

  // TLS/SSL negotiation
  if (lower.includes('ssl') || lower.includes('tls') || lower.includes('certificate')) {
    return {
      code: code || 'ETLS',
      hint: 'TLS/SSL 协商失败。请确认端口与 secure 设置匹配（IMAPS 通常 993 + secure=true）。',
    };
  }

  return {
    code: code || 'EUNKNOWN',
    hint: `连接失败：${msg || '未知错误'}`,
  };
}

/**
 * Raw TCP reachability probe with an explicit timeout.
 * Resolves { ok, code, error } — never rejects, never hangs.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 */
export async function probeTcp(host, port, timeoutMs = 8000) {
  const net = await import('node:net');
  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = new net.Socket();
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolvePromise(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, code: 'ETIMEDOUT', error: `TCP 连接 ${host}:${port} 超时` }));
    socket.once('error', (err) => done({ ok: false, code: err.code || 'ECONN', error: err.message }));
    try {
      socket.connect(port, host);
    } catch (err) {
      done({ ok: false, code: err.code || 'ECONN', error: err.message });
    }
  });
}

/**
 * Two-stage mailbox connectivity precheck (Spec §6.8.6.11).
 * Mirrors the server-side EmailService.testConnection contract, but with
 * explicit timeouts so it never hangs on a blocked corporate network.
 *
 * Credentials come ONLY from process.env[mb.passwordEnv].
 *
 * @param {object} cfg - Resolved config with cfg.mailbox
 * @param {{tcpTimeoutMs?:number, imapTimeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, stage:string, code?:string, hint?:string, mailboxCount?:number}>}
 */
export async function precheckMailbox(cfg, opts = {}) {
  const mb = cfg.mailbox;
  if (!mb) {
    return { ok: false, stage: 'config', code: 'ENOCONFIG', hint: 'mailbox 配置缺失，请先运行 setup 配置邮箱。' };
  }
  if (!mb.host) {
    return { ok: false, stage: 'config', code: 'ENOHOST', hint: '未配置 mailbox.host（或未选择 provider 预设）。' };
  }

  const passwordEnv = mb.passwordEnv || 'REBU_IMAP_PASS';
  const password = process.env[passwordEnv];
  if (!password) {
    return {
      ok: false,
      stage: 'config',
      code: 'ENOPASS',
      hint: `环境变量 ${passwordEnv} 未设置。请先通过环境变量提供 IMAP 密码/授权码（不要写入配置或对话）。`,
    };
  }

  const port = mb.port || 993;
  const tcpTimeoutMs = opts.tcpTimeoutMs || 8000;
  const imapTimeoutMs = opts.imapTimeoutMs || 15000;

  // Stage A: TCP reachability
  const tcp = await probeTcp(mb.host, port, tcpTimeoutMs);
  if (!tcp.ok) {
    const { code, hint } = classifyConnectError({ code: tcp.code, message: tcp.error }, 'tcp');
    return { ok: false, stage: 'tcp', code, hint };
  }

  // Stage B: IMAP connect + list
  let ImapFlow;
  try {
    ({ ImapFlow } = await import('imapflow'));
  } catch {
    return {
      ok: false,
      stage: 'deps',
      code: 'ENODEP',
      hint: '未找到 imapflow 依赖。请在仓库内运行（npm i 已含），或在宿主环境安装 imapflow。',
    };
  }

  const client = new ImapFlow({
    host: mb.host,
    port,
    secure: mb.secure !== false,
    auth: { user: mb.user, pass: password },
    logger: false,
    // Explicit timeouts so a blocked network fails fast instead of hanging
    greetingTimeout: imapTimeoutMs,
    socketTimeout: imapTimeoutMs,
    connectionTimeout: imapTimeoutMs,
  });

  try {
    await client.connect();
    const list = await client.list();
    await client.logout();
    return { ok: true, stage: 'imap', mailboxCount: Array.isArray(list) ? list.length : undefined };
  } catch (err) {
    try { await client.logout(); } catch { /* ignore */ }
    const { code, hint } = classifyConnectError(err, 'imap');
    return { ok: false, stage: 'imap', code, hint };
  }
}

/**
 * Extract attachment info objects from imapflow bodyStructure (recursive).
 */
export function extractAttachments(structure, prefix = '') {
  const results = [];
  if (!structure) return results;

  if (structure.childNodes && Array.isArray(structure.childNodes)) {
    for (let i = 0; i < structure.childNodes.length; i++) {
      const partNum = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      results.push(...extractAttachments(structure.childNodes[i], partNum));
    }
  } else {
    const part = prefix || '1';
    const disp = structure.disposition;
    const filename = structure.dispositionParameters?.filename
      || structure.parameters?.name
      || '';

    if (disp === 'attachment' || (filename && isInvoiceAttachment(filename))) {
      results.push({
        part,
        filename: filename || `part_${part}`,
        contentType: `${structure.type || 'application'}/${structure.subtype || 'octet-stream'}`,
        size: structure.size || 0,
      });
    }
  }
  return results;
}

// ─── State helpers ───────────────────────────────────────────────────

function loadMailboxState(statePath) {
  if (!existsSync(statePath)) return { mailbox: {} };
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf-8'));
    return data;
  } catch {
    return { mailbox: {} };
  }
}

function saveMailboxState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Main filler ─────────────────────────────────────────────────────

/**
 * Fill inbox from mailbox. Returns number of newly downloaded attachments.
 * @param {object} cfg - Resolved config from resolveConfig()
 * @returns {Promise<number>} Count of downloaded files
 */
export async function fillMailbox(cfg) {
  const mb = cfg.mailbox;
  if (!mb) {
    throw new Error('mailbox 配置缺失');
  }

  // Resolve password from environment
  const password = process.env[mb.passwordEnv || 'REBU_IMAP_PASS'];
  if (!password) {
    throw new Error(
      `环境变量 ${mb.passwordEnv || 'REBU_IMAP_PASS'} 未设置。` +
      `请通过环境变量提供 IMAP 密码/授权码。`
    );
  }

  // Dynamic import of imapflow (already installed in repo)
  const { ImapFlow } = await import('imapflow');

  const state = loadMailboxState(cfg.statePath);
  if (!state.mailbox) state.mailbox = {};

  const client = new ImapFlow({
    host: mb.host,
    port: mb.port || 993,
    secure: mb.secure !== false,
    auth: { user: mb.user, pass: password },
    logger: false,
    // Explicit timeouts so a blocked corporate network fails fast (Spec §6.8.6.11)
    greetingTimeout: mb.greetingTimeoutMs || 15000,
    socketTimeout: mb.socketTimeoutMs || 30000,
    connectionTimeout: mb.connectionTimeoutMs || 15000,
  });

  let downloaded = 0;

  try {
    await client.connect();
    const folder = mb.folder || 'INBOX';
    const mailbox = await client.mailboxOpen(folder);
    const currentUidValidity = String(mailbox.uidValidity);

    // Determine search criteria
    let searchCriteria;
    const lastUid = state.mailbox.lastUid || 0;
    const lastUidValidity = state.mailbox.uidValidity || '';

    if (lastUid > 0 && lastUidValidity === currentUidValidity) {
      // Incremental: only newer UIDs
      searchCriteria = { uid: `${lastUid + 1}:*` };
    } else {
      // Full scan: use sinceDays
      const since = computeSinceDate(mb.sinceDays || 30);
      searchCriteria = { since };
    }

    // Search messages
    const uids = [];
    for await (const msg of client.fetch(searchCriteria, { uid: true, envelope: true, bodyStructure: true })) {
      uids.push(msg);
    }

    let maxUid = lastUid;
    const downloadedKeys = new Set(state.mailbox.downloadedKeys || []);

    for (const msg of uids) {
      const uid = msg.uid;
      if (uid <= lastUid && lastUidValidity === currentUidValidity) continue;

      // Subject filter
      const subject = msg.envelope?.subject || '';
      if (!matchesSubjectFilter(subject, mb.subjectFilter)) continue;

      // Extract attachments
      const attachments = extractAttachments(msg.bodyStructure);
      const invoiceAttachments = attachments.filter(a => isInvoiceAttachment(a.filename));

      for (const att of invoiceAttachments) {
        const dedupeKey = mailDedupeKey(uid, currentUidValidity, att.filename);
        if (downloadedKeys.has(dedupeKey)) continue;

        try {
          const { content } = await client.download(String(uid), att.part, { uid: true });
          const safeName = `${uid}_${att.filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`;
          const destPath = join(cfg.inboxDir, safeName);

          mkdirSync(cfg.inboxDir, { recursive: true });
          const ws = createWriteStream(destPath);
          await pipeline(content, ws);

          downloadedKeys.add(dedupeKey);
          downloaded++;
          console.log(`    ↓ ${safeName}`);
        } catch (err) {
          console.warn(`    ⚠ 下载失败 uid=${uid} part=${att.part}: ${err.message}`);
        }
      }

      if (uid > maxUid) maxUid = uid;
    }

    // Update state
    state.mailbox.lastUid = maxUid;
    state.mailbox.uidValidity = currentUidValidity;
    state.mailbox.downloadedKeys = [...downloadedKeys];
    state.mailbox.lastRun = new Date().toISOString();
    saveMailboxState(cfg.statePath, state);

    await client.logout();
  } catch (err) {
    try { await client.logout(); } catch { /* ignore */ }
    const { hint } = classifyConnectError(err, 'imap');
    const wrapped = new Error(`${err.message}${hint ? ` — ${hint}` : ''}`);
    wrapped.code = err.code;
    throw wrapped;
  }

  return downloaded;
}
