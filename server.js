const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.SERVICE_DESK_PORT || 8080);
const HOST = process.env.SERVICE_DESK_HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.SERVICE_DESK_DATA_DIR || path.join(ROOT, 'data'));
const BACKUP_DIR = path.resolve(process.env.SERVICE_DESK_BACKUP_DIR || path.join(ROOT, 'backups'));
const ATTACHMENTS_DIR = path.resolve(process.env.SERVICE_DESK_ATTACHMENTS_DIR || path.join(ROOT, 'attachments'));
const DB_PATH = path.join(DATA_DIR, 'service-desk.sqlite');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const BACKUP_RETENTION = Math.max(7, Number(process.env.SERVICE_DESK_BACKUP_RETENTION || 30));
const DAILY_BACKUP_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    machine TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    warranty TEXT NOT NULL DEFAULT '',
    order_number TEXT NOT NULL DEFAULT '',
    manufactured_date TEXT NOT NULL DEFAULT '',
    improvement_unit TEXT NOT NULL DEFAULT '',
    report_date TEXT NOT NULL DEFAULT '',
    service_date TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    description TEXT NOT NULL DEFAULT '',
    handling TEXT NOT NULL DEFAULT '',
    is_test INTEGER NOT NULL DEFAULT 0,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY,
    group_name TEXT NOT NULL DEFAULT '待確認',
    pending INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS parts (
    sku TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS customers (
    name TEXT PRIMARY KEY,
    contact TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS machines (
    name TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS category_groups (
    name TEXT PRIMARY KEY,
    protected INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS staff (
    name TEXT PRIMARY KEY,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS warranty_cards (
    number TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    machine TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS case_categories (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    category_name TEXT NOT NULL,
    PRIMARY KEY (case_id, category_name)
  );
  CREATE TABLE IF NOT EXISTS case_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    sku TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT '待處理'
  );
  CREATE TABLE IF NOT EXISTS case_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    asked_at TEXT NOT NULL,
    asker TEXT NOT NULL DEFAULT '',
    respondent TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL DEFAULT '',
    answer TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS case_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT NOT NULL DEFAULT 'admin'
  );
  CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases(updated);
  CREATE INDEX IF NOT EXISTS idx_case_categories_name ON case_categories(category_name);
  CREATE INDEX IF NOT EXISTS idx_case_parts_sku ON case_parts(sku);
  CREATE INDEX IF NOT EXISTS idx_case_inquiries_case_id ON case_inquiries(case_id);
  CREATE INDEX IF NOT EXISTS idx_case_attachments_case_id ON case_attachments(case_id);
`);

if (!db.prepare('PRAGMA table_info(cases)').all().some(column => column.name === 'is_test')) {
  db.exec('ALTER TABLE cases ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
}
for (const [column, definition] of [['order_number', "TEXT NOT NULL DEFAULT ''"], ['manufactured_date', "TEXT NOT NULL DEFAULT ''"], ['improvement_unit', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!db.prepare('PRAGMA table_info(cases)').all().some(item => item.name === column)) db.exec(`ALTER TABLE cases ADD COLUMN ${column} ${definition}`);
}

db.prepare('INSERT OR IGNORE INTO category_groups(name, protected) VALUES(?, 1)').run('待確認');
for (const row of db.prepare('SELECT DISTINCT group_name AS name FROM categories WHERE TRIM(group_name) <> \'\'').all()) {
  db.prepare('INSERT OR IGNORE INTO category_groups(name, protected) VALUES(?, 0)').run(row.name);
}
for (const row of db.prepare('SELECT DISTINCT owner AS name FROM cases WHERE TRIM(owner) <> \'\'').all()) {
  db.prepare('INSERT OR IGNORE INTO staff(name, active) VALUES(?, 1)').run(row.name);
}
for (const row of db.prepare('SELECT warranty AS number,customer,machine FROM cases WHERE TRIM(warranty) <> \'\' ORDER BY updated,id').all()) {
  db.prepare('INSERT OR IGNORE INTO warranty_cards(number,customer,machine) VALUES(?,?,?)').run(row.number,row.customer,row.machine);
}

function nowIso() { return new Date().toISOString(); }
function json(value) { return JSON.stringify(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function setting(key) { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
function setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, encoded) {
  if (!encoded || !encoded.includes(':')) return false;
  const [salt, expected] = encoded.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
function ensureAdminPassword() {
  if (setting('admin_password_hash')) return;
  const password = process.env.SERVICE_DESK_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('尚未設定管理者密碼。首次啟動前請設定環境變數 SERVICE_DESK_ADMIN_PASSWORD；密碼不會寫入程式碼或資料庫明文。');
  }
  if (password.length < 8) throw new Error('SERVICE_DESK_ADMIN_PASSWORD 至少需要 8 個字元。');
  setSetting('admin_password_hash', hashPassword(password));
}
ensureAdminPassword();

function readState() {
  const cases = db.prepare('SELECT * FROM cases ORDER BY updated DESC').all().map(row => ({
    id: row.id, customer: row.customer, machine: row.machine, contact: row.contact, phone: row.phone,
    address: row.address, warranty: row.warranty, orderNumber: row.order_number, manufacturedDate: row.manufactured_date,
    improvementUnit: row.improvement_unit, reportDate: row.report_date, serviceDate: row.service_date,
    owner: row.owner, status: row.status, description: row.description, handling: row.handling, isTest: Boolean(row.is_test), updated: row.updated,
    categories: db.prepare('SELECT category_name FROM case_categories WHERE case_id = ? ORDER BY category_name').all(row.id).map(item => item.category_name),
    parts: db.prepare('SELECT sku,name,method,quantity,state FROM case_parts WHERE case_id = ? ORDER BY id').all(row.id),
    inquiries: db.prepare('SELECT id,asked_at AS askedAt,asker,respondent,question,answer FROM case_inquiries WHERE case_id = ? ORDER BY asked_at,id').all(row.id)
  }));
  return {
    cases,
    categories: db.prepare('SELECT name,group_name AS "group",pending FROM categories ORDER BY name').all().map(row => ({ ...row, pending: Boolean(row.pending) })),
    groups: db.prepare('SELECT name,protected FROM category_groups ORDER BY protected DESC,name').all().map(row => ({ ...row, protected: Boolean(row.protected) })),
    parts: db.prepare('SELECT sku,name,method,note,active FROM parts ORDER BY sku').all().map(row => ({ ...row, active: Boolean(row.active) })),
    customers: db.prepare('SELECT name,contact,phone,address FROM customers ORDER BY name').all(),
    machines: db.prepare('SELECT name,note FROM machines ORDER BY name').all(),
    staff: db.prepare('SELECT name,active FROM staff ORDER BY active DESC,name').all().map(row => ({ ...row, active: Boolean(row.active) })),
    warrantyCards: db.prepare('SELECT number,customer,machine FROM warranty_cards ORDER BY customer,number').all()
  };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object') throw new Error('資料格式無效。');
  const keys = ['cases', 'categories', 'parts', 'customers', 'machines'];
  if (!keys.every(key => Array.isArray(input[key]))) throw new Error('備份資料缺少必要欄位。');
  const cases = input.cases.map(item => ({
      id: String(item.id || '').trim(), customer: String(item.customer || '').trim(), machine: String(item.machine || '').trim(),
      contact: String(item.contact || ''), phone: String(item.phone || ''), address: String(item.address || ''), warranty: String(item.warranty || '').trim(),
      orderNumber: String(item.orderNumber || '').trim(), manufacturedDate: String(item.manufacturedDate || ''), improvementUnit: String(item.improvementUnit || '').trim(),
      reportDate: String(item.reportDate || ''), serviceDate: String(item.serviceDate || ''), owner: String(item.owner || ''), status: String(item.status || 'new'),
      description: String(item.description || ''), handling: String(item.handling || ''), isTest: Boolean(item.isTest), updated: String(item.updated || nowIso()),
      categories: Array.isArray(item.categories) ? item.categories.map(String).filter(Boolean) : [],
      parts: Array.isArray(item.parts) ? item.parts.map(part => ({ sku: String(part.sku || ''), name: String(part.name || ''), method: String(part.method || ''), quantity: Math.max(1, Number(part.quantity) || 1), state: String(part.state || '待處理') })).filter(part => part.sku || part.name) : [],
      inquiries: Array.isArray(item.inquiries) ? item.inquiries.map(inquiry => ({ askedAt: String(inquiry.askedAt || nowIso()), asker: String(inquiry.asker || ''), respondent: String(inquiry.respondent || ''), question: String(inquiry.question || ''), answer: String(inquiry.answer || '') })).filter(inquiry => inquiry.asker || inquiry.respondent || inquiry.question || inquiry.answer) : []
    })).map(item => { if (!item.id || !item.customer || !item.machine || !item.description) throw new Error('每筆案件都需要案號、客戶、機型與故障描述。'); return item; });
  const categories = input.categories.map(item => ({ name: String(item.name || '').trim(), group: String(item.group || '待確認').trim() || '待確認', pending: Boolean(item.pending) })).filter(item => item.name);
  const groupNames = new Set(['待確認', ...categories.map(item => item.group)]);
  const groups = (Array.isArray(input.groups) ? input.groups : []).map(item => ({ name: String(item.name || '').trim(), protected: Boolean(item.protected) })).filter(item => item.name);
  for (const name of groupNames) if (!groups.some(item => item.name === name)) groups.push({ name, protected: name === '待確認' });
  if (!groups.some(item => item.name === '待確認')) groups.push({ name: '待確認', protected: true });
  const staff = (Array.isArray(input.staff) ? input.staff : []).map(item => ({ name: String(item.name || '').trim(), active: item.active !== false })).filter(item => item.name);
  for (const owner of cases.map(item => item.owner).filter(Boolean)) if (!staff.some(item => item.name === owner)) staff.push({ name: owner, active: true });
  const warrantyCards = (Array.isArray(input.warrantyCards) ? input.warrantyCards : []).map(item => ({ number: String(item.number || '').trim(), customer: String(item.customer || '').trim(), machine: String(item.machine || '').trim() })).filter(item => item.number && item.customer && item.machine);
  const warrantyByNumber = new Map();
  for (const card of [...warrantyCards, ...cases.filter(item => item.warranty).map(item => ({ number: item.warranty.trim(), customer: item.customer, machine: item.machine }))]) {
    const key = card.number.toLocaleLowerCase();
    const existing = warrantyByNumber.get(key);
    if (existing && (existing.customer !== card.customer || existing.machine !== card.machine)) throw new Error(`保修卡「${card.number}」已綁定其他客戶或機台，請先核對資料。`);
    if (!existing) warrantyByNumber.set(key, card);
  }
  return {
    cases,
    categories,
    groups,
    parts: input.parts.map(item => ({ sku: String(item.sku || '').trim(), name: String(item.name || '').trim(), method: String(item.method || ''), note: String(item.note || ''), active: item.active !== false })).filter(item => item.sku && item.name),
    customers: input.customers.map(item => ({ name: String(item.name || '').trim(), contact: String(item.contact || ''), phone: String(item.phone || ''), address: String(item.address || '') })).filter(item => item.name),
    machines: input.machines.map(item => ({ name: String(item.name || '').trim(), note: String(item.note || '') })).filter(item => item.name),
    staff,
    warrantyCards: [...warrantyByNumber.values()]
  };
}

function replaceState(input) {
  const state = normalizeState(input);
  const existingAttachments = db.prepare('SELECT id,case_id,original_name,stored_name,relative_path,mime_type,size,uploaded_at,uploaded_by FROM case_attachments').all();
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    db.exec('DELETE FROM case_attachments; DELETE FROM case_categories; DELETE FROM case_parts; DELETE FROM case_inquiries; DELETE FROM cases; DELETE FROM categories; DELETE FROM category_groups; DELETE FROM parts; DELETE FROM customers; DELETE FROM machines; DELETE FROM staff; DELETE FROM warranty_cards;');
    const insertCase = db.prepare('INSERT INTO cases(id,customer,machine,contact,phone,address,warranty,order_number,manufactured_date,improvement_unit,report_date,service_date,owner,status,description,handling,is_test,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertCategoryLink = db.prepare('INSERT INTO case_categories(case_id,category_name) VALUES(?,?)');
    const insertPartLink = db.prepare('INSERT INTO case_parts(case_id,sku,name,method,quantity,state) VALUES(?,?,?,?,?,?)');
    const insertInquiry = db.prepare('INSERT INTO case_inquiries(case_id,asked_at,asker,respondent,question,answer) VALUES(?,?,?,?,?,?)');
    for (const item of state.cases) {
      insertCase.run(item.id,item.customer,item.machine,item.contact,item.phone,item.address,item.warranty,item.orderNumber,item.manufacturedDate,item.improvementUnit,item.reportDate,item.serviceDate,item.owner,item.status,item.description,item.handling,item.isTest ? 1 : 0,item.updated);
      for (const category of item.categories) insertCategoryLink.run(item.id, category);
      for (const part of item.parts) insertPartLink.run(item.id,part.sku,part.name,part.method,part.quantity,part.state);
      for (const inquiry of item.inquiries) insertInquiry.run(item.id,inquiry.askedAt,inquiry.asker,inquiry.respondent,inquiry.question,inquiry.answer);
    }
    const caseIds = new Set(state.cases.map(item => item.id));
    const insertAttachment = db.prepare('INSERT INTO case_attachments(id,case_id,original_name,stored_name,relative_path,mime_type,size,uploaded_at,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const attachment of existingAttachments) if (caseIds.has(attachment.case_id)) insertAttachment.run(attachment.id,attachment.case_id,attachment.original_name,attachment.stored_name,attachment.relative_path,attachment.mime_type,attachment.size,attachment.uploaded_at,attachment.uploaded_by);
    const insertGroup = db.prepare('INSERT INTO category_groups(name,protected) VALUES(?,?)');
    for (const item of state.groups) insertGroup.run(item.name,item.protected ? 1 : 0);
    const insertCategory = db.prepare('INSERT INTO categories(name,group_name,pending) VALUES(?,?,?)');
    for (const item of state.categories) insertCategory.run(item.name,item.group,item.pending ? 1 : 0);
    const insertPart = db.prepare('INSERT INTO parts(sku,name,method,note,active) VALUES(?,?,?,?,?)');
    for (const item of state.parts) insertPart.run(item.sku,item.name,item.method,item.note,item.active ? 1 : 0);
    const insertCustomer = db.prepare('INSERT INTO customers(name,contact,phone,address) VALUES(?,?,?,?)');
    for (const item of state.customers) insertCustomer.run(item.name,item.contact,item.phone,item.address);
    const insertMachine = db.prepare('INSERT INTO machines(name,note) VALUES(?,?)');
    for (const item of state.machines) insertMachine.run(item.name,item.note);
    const insertStaff = db.prepare('INSERT INTO staff(name,active) VALUES(?,?)');
    for (const item of state.staff) insertStaff.run(item.name,item.active ? 1 : 0);
    const insertWarranty = db.prepare('INSERT INTO warranty_cards(number,customer,machine) VALUES(?,?,?)');
    for (const item of state.warrantyCards) insertWarranty.run(item.number,item.customer,item.machine);
    db.prepare('COMMIT').run();
  } catch (error) {
    db.prepare('ROLLBACK').run();
    throw error;
  }
  return state;
}

function makeDatabaseBackup() {
  const file = path.join(BACKUP_DIR, `service-desk-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  pruneBackups();
  return file;
}
function pruneBackups() {
  const files = fs.readdirSync(BACKUP_DIR).filter(name => /^service-desk-.*\.sqlite$/.test(name)).sort().reverse();
  for (const file of files.slice(BACKUP_RETENTION)) fs.rmSync(path.join(BACKUP_DIR, file), { force: true });
}

const sessions = new Map();
const failedLogins = new Map();
function cleanupSessions() { const cutoff = Date.now(); for (const [token, session] of sessions) if (session.expiresAt <= cutoff) sessions.delete(token); }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(pair => pair.length === 2).map(([key,...value]) => [key, decodeURIComponent(value.join('='))])); }
function sessionFrom(req) { cleanupSessions(); const token = parseCookies(req).service_desk_session; const session = token && sessions.get(token); return session && session.expiresAt > Date.now() ? session : null; }
function isAdmin(req) { return sessionFrom(req)?.role === 'admin'; }
function send(res, status, body, headers = {}) { const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers }); res.end(payload); }
function error(res, status, message) { send(res, status, { error: message }); }
function requireAdmin(req, res) { if (!isAdmin(req)) { error(res, 403, '需要管理者登入才能執行此操作。'); return false; } return true; }
function readRawBody(req, maxBytes) { return new Promise((resolve, reject) => { const advertised = Number(req.headers['content-length'] || 0); if (advertised > maxBytes) return reject(new Error('上傳檔案過大。')); let size = 0; const chunks = []; let settled = false; req.on('data', chunk => { if (settled) return; size += chunk.length; if (size > maxBytes) { settled = true; reject(new Error('上傳檔案過大。')); return; } chunks.push(chunk); }); req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } }); req.on('error', error => { if (!settled) { settled = true; reject(error); } }); }); }
function readBody(req) { return readRawBody(req, MAX_JSON_BODY_BYTES).then(buffer => { try { return JSON.parse(buffer.toString('utf8') || '{}'); } catch { throw new Error('請提供有效的 JSON 資料。'); } }); }
function backupPayload() { return { format: 'service-desk-backup', version: 1, exportedAt: nowIso(), data: readState() }; }
function setSessionCookie(res, token, maxAge = SESSION_TTL_MS / 1000) { res.setHeader('Set-Cookie', `service_desk_session=${encodeURIComponent(token)}; Max-Age=${Math.floor(maxAge)}; Path=/; HttpOnly; SameSite=Lax`); }
function resourceItems(state, resource) { const map = { cases: 'cases', categories: 'categories', groups: 'groups', parts: 'parts', customers: 'customers', machines: 'machines', staff: 'staff' }; return map[resource] ? state[map[resource]] : null; }
function resourceKey(resource, item) { return resource === 'cases' ? item.id : resource === 'parts' ? item.sku : item.name; }
function sanitizeFileName(value) { return String(value || '附件').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 160) || '附件'; }
function caseFolderName(item) { const date = String(item.serviceDate || item.reportDate || nowIso().slice(0, 10)).replace(/[^0-9-]/g, ''); return sanitizeFileName(`${item.customer}_${date}_${item.id}`); }
function getCaseById(id) { return db.prepare('SELECT id,customer,report_date AS reportDate,service_date AS serviceDate FROM cases WHERE id = ?').get(id) || null; }
function attachmentFolderForCase(item) { const existing = db.prepare('SELECT relative_path FROM case_attachments WHERE case_id = ? ORDER BY id LIMIT 1').get(item.id); if (existing?.relative_path) return path.join(ATTACHMENTS_DIR, path.dirname(existing.relative_path)); return path.join(ATTACHMENTS_DIR, caseFolderName(item)); }
function attachmentRecord(row) { return { id: row.id, originalName: row.original_name, mimeType: row.mime_type, size: row.size, uploadedAt: row.uploaded_at, uploadedBy: row.uploaded_by }; }
function listAttachments(caseId) { return db.prepare('SELECT id,original_name,mime_type,size,uploaded_at,uploaded_by FROM case_attachments WHERE case_id = ? ORDER BY uploaded_at,id').all(caseId).map(attachmentRecord); }
function allowedAttachment(name, mime) { const extension = path.extname(String(name || '')).toLocaleLowerCase(); const allowedExtensions = new Set(['.jpg','.jpeg','.png','.gif','.webp','.bmp','.heic','.mp4','.mov','.avi','.mkv','.webm','.m4v','.3gp']); return (String(mime || '').startsWith('image/') || String(mime || '').startsWith('video/')) && allowedExtensions.has(extension); }
function attachmentPath(row) { const root = path.resolve(ATTACHMENTS_DIR); const file = path.resolve(root, row.relative_path); if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error('附件路徑無效。'); return file; }
function deleteCaseAttachments(caseId, item = getCaseById(caseId)) { const rows = db.prepare('SELECT relative_path FROM case_attachments WHERE case_id = ?').all(caseId); const folders = new Set(rows.map(row => path.dirname(attachmentPath(row)))); if (item) folders.add(attachmentFolderForCase(item)); for (const row of rows) fs.rmSync(attachmentPath(row), { force: true }); for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); }
function deleteCase(caseId) { const item = getCaseById(caseId); if (!item) return false; deleteCaseAttachments(caseId, item); db.prepare('DELETE FROM cases WHERE id = ?').run(caseId); return true; }

function deleteTestCases() {
  const ids = db.prepare('SELECT id FROM cases WHERE is_test = 1 ORDER BY id').all().map(row => row.id);
  for (const id of ids) deleteCase(id);
  return ids.length;
}

function route(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true, service: 'service-desk', time: nowIso() });
  if (req.method === 'GET' && pathname === '/api/session') return send(res, 200, { authenticated: isAdmin(req), role: isAdmin(req) ? 'admin' : 'guest' });
  if (req.method === 'POST' && pathname === '/api/login') return readBody(req).then(body => {
    const address = req.socket.remoteAddress || 'unknown'; const attempt = failedLogins.get(address) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) return error(res, 429, '登入嘗試過於頻繁，請稍後再試。');
    const password = String(body.password || '');
    if (!verifyPassword(password, setting('admin_password_hash'))) {
      attempt.count += 1; if (attempt.count >= 5) { attempt.count = 0; attempt.blockedUntil = Date.now() + 60_000; } failedLogins.set(address, attempt);
      return setTimeout(() => error(res, 401, '管理者密碼不正確。'), 350);
    }
    failedLogins.delete(address); const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, { role: 'admin', expiresAt: Date.now() + SESSION_TTL_MS }); setSessionCookie(res, token); return send(res, 200, { authenticated: true, role: 'admin' });
  }).catch(e => error(res, 400, e.message));
  if (req.method === 'POST' && pathname === '/api/logout') { const token = parseCookies(req).service_desk_session; if (token) sessions.delete(token); setSessionCookie(res, '', 0); return send(res, 200, { authenticated: false, role: 'guest' }); }
  if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, { data: readState() });
  if (req.method === 'GET' && pathname === '/api/test-data/count') { if (!requireAdmin(req, res)) return; return send(res, 200, { data: { cases: db.prepare('SELECT COUNT(*) AS count FROM cases WHERE is_test = 1').get().count } }); }
  if (req.method === 'DELETE' && pathname === '/api/test-data') { if (!requireAdmin(req, res)) return; return send(res, 200, { data: { deleted: deleteTestCases() } }); }
  if (req.method === 'PUT' && pathname === '/api/state') { if (!requireAdmin(req, res)) return; return readBody(req).then(body => send(res, 200, { data: replaceState(body.data || body) })).catch(e => error(res, 400, e.message)); }
  if (req.method === 'GET' && pathname === '/api/cases') return send(res, 200, { data: readState().cases });
  const caseMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (caseMatch && req.method === 'GET') { const item = readState().cases.find(entry => entry.id === decodeURIComponent(caseMatch[1])); return item ? send(res, 200, { data: item }) : error(res, 404, '找不到案件。'); }
  if (caseMatch && req.method === 'DELETE') { if (!requireAdmin(req, res)) return; return deleteCase(decodeURIComponent(caseMatch[1])) ? send(res, 200, { data: { deleted: true } }) : error(res, 404, '找不到案件。'); }
  const attachmentCollectionMatch = pathname.match(/^\/api\/cases\/([^/]+)\/attachments$/);
  if (attachmentCollectionMatch && req.method === 'GET') { const caseId = decodeURIComponent(attachmentCollectionMatch[1]); if (!getCaseById(caseId)) return error(res, 404, '找不到案件。'); return send(res, 200, { data: listAttachments(caseId) }); }
  if (attachmentCollectionMatch && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const caseId = decodeURIComponent(attachmentCollectionMatch[1]); const item = getCaseById(caseId); if (!item) return error(res, 404, '找不到案件。');
    const encodedName = String(req.headers['x-file-name'] || '附件'); let decodedName = encodedName; try { decodedName = decodeURIComponent(encodedName); } catch { /* keep the raw header when it is not URI encoded */ } const originalName = sanitizeFileName(decodedName); const mimeType = String(req.headers['x-file-type'] || req.headers['content-type'] || '');
    if (!allowedAttachment(originalName, mimeType)) return error(res, 400, '只允許上傳圖片或影片檔案。');
    return readRawBody(req, MAX_ATTACHMENT_BYTES).then(buffer => {
      const folder = attachmentFolderForCase(item); fs.mkdirSync(folder, { recursive: true });
      const storedName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${originalName}`; const filePath = path.join(folder, storedName); const relativePath = path.relative(ATTACHMENTS_DIR, filePath);
      fs.writeFileSync(filePath, buffer);
      try { const result = db.prepare('INSERT INTO case_attachments(case_id,original_name,stored_name,relative_path,mime_type,size,uploaded_at,uploaded_by) VALUES(?,?,?,?,?,?,?,?)').run(caseId, originalName, storedName, relativePath, mimeType, buffer.length, nowIso(), 'admin'); return send(res, 201, { data: { id: result.lastInsertRowid, originalName, mimeType, size: buffer.length, uploadedAt: nowIso(), uploadedBy: 'admin' } }); } catch (error) { fs.rmSync(filePath, { force: true }); throw error; }
    }).catch(e => error(res, 400, e.message));
  }
  const attachmentDownloadMatch = pathname.match(/^\/api\/cases\/([^/]+)\/attachments\/(\d+)$/);
  if (attachmentDownloadMatch && req.method === 'GET') {
    const caseId = decodeURIComponent(attachmentDownloadMatch[1]); const row = db.prepare('SELECT * FROM case_attachments WHERE id = ? AND case_id = ?').get(Number(attachmentDownloadMatch[2]), caseId); if (!row) return error(res, 404, '找不到附件。');
    const filePath = attachmentPath(row); if (!fs.existsSync(filePath)) return error(res, 404, '附件檔案不存在。'); const stat = fs.statSync(filePath); res.writeHead(200, { 'Content-Type': row.mime_type, 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`, 'Cache-Control': 'no-store' }); return fs.createReadStream(filePath).pipe(res);
  }
  if (attachmentDownloadMatch && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return; const caseId = decodeURIComponent(attachmentDownloadMatch[1]); const row = db.prepare('SELECT * FROM case_attachments WHERE id = ? AND case_id = ?').get(Number(attachmentDownloadMatch[2]), caseId); if (!row) return error(res, 404, '找不到附件。'); const filePath = attachmentPath(row); fs.rmSync(filePath, { force: true }); db.prepare('DELETE FROM case_attachments WHERE id = ?').run(row.id); return send(res, 200, { data: { deleted: true } });
  }
  const openFolderMatch = pathname.match(/^\/api\/cases\/([^/]+)\/attachments\/open-folder$/);
  if (openFolderMatch && req.method === 'POST') {
    if (!requireAdmin(req, res)) return; const caseId = decodeURIComponent(openFolderMatch[1]); const item = getCaseById(caseId); if (!item) return error(res, 404, '找不到案件。'); if (process.platform !== 'win32') return error(res, 501, '只有 Windows 伺服器可以使用開啟資料夾功能。'); const folder = attachmentFolderForCase(item); fs.mkdirSync(folder, { recursive: true }); try { const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }); child.unref(); return send(res, 200, { data: { opened: true } }); } catch (error) { return error(res, 500, `無法開啟伺服器資料夾：${error.message}`); }
  }
  const resourceMatch = pathname.match(/^\/api\/(cases|categories|groups|parts|customers|machines|staff)(?:\/([^/]+))?$/);
  if (resourceMatch && req.method === 'GET') {
    const state = readState(); const items = resourceItems(state, resourceMatch[1]);
    if (!resourceMatch[2]) return send(res, 200, { data: items });
    const item = items.find(entry => resourceKey(resourceMatch[1], entry) === decodeURIComponent(resourceMatch[2]));
    return item ? send(res, 200, { data: item }) : error(res, 404, '找不到資料。');
  }
  if (resourceMatch && ['POST','PUT','DELETE'].includes(req.method)) {
    if (!requireAdmin(req, res)) return;
    return readBody(req).then(body => {
      const resource = resourceMatch[1]; const state = readState(); const items = resourceItems(state, resource); const key = resourceMatch[2] ? decodeURIComponent(resourceMatch[2]) : null;
      if (req.method === 'POST') { items.push(body.data || body); }
      if (req.method === 'PUT') { const index = items.findIndex(item => resourceKey(resource, item) === key); if (index < 0) return error(res, 404, '找不到要修改的資料。'); items[index] = body.data || body; }
      if (req.method === 'DELETE') {
        if (resource === 'categories') for (const item of state.cases) item.categories = (item.categories || []).filter(name => name !== key);
        if (resource === 'parts' && state.cases.some(item => (item.parts || []).some(part => part.sku === key))) return error(res, 409, '此零件仍被案件使用，無法刪除。');
        if (resource === 'groups' && key === '待確認') return error(res, 409, '「待確認」是系統保留分類族群，無法刪除。');
        if (resource === 'groups') for (const category of state.categories.filter(item => item.group === key)) category.group = '待確認';
        if (resource === 'staff' && state.cases.some(item => item.owner === key)) return error(res, 409, '此人員仍被歷史案件使用，請改用停用。');
        const index = items.findIndex(item => resourceKey(resource, item) === key); if (index < 0) return error(res, 404, '找不到要刪除的資料。'); items.splice(index, 1);
      }
      return send(res, 200, { data: replaceState(state) });
    }).catch(e => error(res, 400, e.message));
  }
  if (req.method === 'GET' && pathname === '/api/backup') { if (!requireAdmin(req, res)) return; const file = makeDatabaseBackup(); return send(res, 200, backupPayload(), { 'Content-Disposition': `attachment; filename="service-desk-backup-${new Date().toISOString().slice(0,10)}.json"`, 'X-Database-Backup': path.basename(file) }); }
  if (req.method === 'POST' && pathname === '/api/restore') { if (!requireAdmin(req, res)) return; return readBody(req).then(body => { const payload = body.data || body; if (payload.format !== 'service-desk-backup' || payload.version !== 1) throw new Error('這不是有效的售服系統備份檔。'); makeDatabaseBackup(); return send(res, 200, { data: replaceState(payload.data) }); }).catch(e => error(res, 400, e.message)); }
  if (pathname.startsWith('/api/')) return error(res, 404, '找不到 API。');
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, '不支援的 HTTP 方法。');
  const filePath = pathname === '/' ? path.join(ROOT, 'dist', 'index.html') : path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return error(res, 404, '找不到頁面。');
  const contentType = filePath.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
  const stat = fs.statSync(filePath); res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'no-store' }); if (req.method === 'HEAD') return res.end(); fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => { try { route(req, res); } catch (e) { console.error(e); error(res, 500, '伺服器發生未預期錯誤。'); } });
if (require.main === module) {
  const dailyBackupTimer = setInterval(() => { try { makeDatabaseBackup(); console.log('已完成每日 SQLite 備份。'); } catch (error) { console.error('每日 SQLite 備份失敗：', error.message); } }, DAILY_BACKUP_MS);
  server.listen(PORT, HOST, () => console.log(`售服系統已啟動：http://${HOST}:${PORT}`));
  const shutdown = () => { clearInterval(dailyBackupTimer); db.close(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
module.exports = { db, server, route, readState, replaceState, normalizeState };
