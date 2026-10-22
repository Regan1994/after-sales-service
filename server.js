const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { xlsx } = require('./src/xlsx');

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
const BACKUP_RETENTION = 30;
const BACKUP_CHECK_MS = 60 * 1000;
const CASE_STATUS_VALUES = new Set(['new', 'processing', 'closed', 'void']);
const LEGACY_CASE_STATUS_MAP = {
  waitingCustomer: 'processing', waiting: 'processing', pending: 'processing',
  returned_to_business: 'processing', returned_to_service: 'processing'
};

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
    email TEXT NOT NULL DEFAULT '',
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
    return_reason TEXT NOT NULL DEFAULT '',
    responsibility TEXT NOT NULL DEFAULT '[]',
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
    email TEXT NOT NULL DEFAULT '',
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
    role TEXT NOT NULL DEFAULT 'service',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS responsibility_departments (
    name TEXT PRIMARY KEY,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS responsibility_reasons (
    department TEXT NOT NULL REFERENCES responsibility_departments(name) ON DELETE CASCADE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(department,name)
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
    answer TEXT NOT NULL DEFAULT '',
    created_by_role TEXT NOT NULL DEFAULT 'admin'
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
function addColumn(table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
addColumn('cases', 'email', "TEXT NOT NULL DEFAULT ''");
addColumn('cases', 'return_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('cases', 'responsibility', "TEXT NOT NULL DEFAULT '[]'");
const currentHandlerWasMissing = !db.prepare('PRAGMA table_info(cases)').all().some(column => column.name === 'current_handler');
addColumn('cases', 'current_handler', "TEXT NOT NULL DEFAULT 'sales'");
addColumn('customers', 'email', "TEXT NOT NULL DEFAULT ''");
const staffRolesWereMissing = !db.prepare('PRAGMA table_info(staff)').all().some(column => column.name === 'role');
addColumn('staff', 'role', "TEXT NOT NULL DEFAULT 'service'");
addColumn('case_inquiries', 'created_by_role', "TEXT NOT NULL DEFAULT 'admin'");

if (currentHandlerWasMissing) {
  db.exec("UPDATE cases SET current_handler = CASE WHEN status IN ('new','pending','returned_to_business','closed','void') THEN 'sales' ELSE 'service' END");
}
db.exec("UPDATE cases SET status = CASE status WHEN 'waitingCustomer' THEN 'processing' WHEN 'waiting' THEN 'processing' WHEN 'pending' THEN 'processing' WHEN 'returned_to_business' THEN 'processing' WHEN 'returned_to_service' THEN 'processing' ELSE status END WHERE status IN ('waitingCustomer','waiting','pending','returned_to_business','returned_to_service')");

db.prepare('INSERT OR IGNORE INTO category_groups(name, protected) VALUES(?, 1)').run('待確認');
for (const row of db.prepare('SELECT DISTINCT group_name AS name FROM categories WHERE TRIM(group_name) <> \'\'').all()) {
  db.prepare('INSERT OR IGNORE INTO category_groups(name, protected) VALUES(?, 0)').run(row.name);
}
for (const row of db.prepare('SELECT DISTINCT owner AS name FROM cases WHERE TRIM(owner) <> \'\'').all()) {
  db.prepare('INSERT OR IGNORE INTO staff(name, active) VALUES(?, 1)').run(row.name);
}
if (staffRolesWereMissing) db.exec("UPDATE staff SET role='sales' WHERE name IN (SELECT DISTINCT owner FROM cases WHERE TRIM(owner) <> '')");
for (const row of db.prepare('SELECT warranty AS number,customer,machine FROM cases WHERE TRIM(warranty) <> \'\' ORDER BY updated,id').all()) {
  db.prepare('INSERT OR IGNORE INTO warranty_cards(number,customer,machine) VALUES(?,?,?)').run(row.number,row.customer,row.machine);
}
for (const row of db.prepare('SELECT customer AS name,contact,phone,email,address FROM cases WHERE TRIM(customer) <> \'\' ORDER BY updated DESC,id DESC').all()) {
  if (!db.prepare('SELECT 1 FROM customers WHERE name = ? COLLATE NOCASE').get(row.name)) db.prepare('INSERT INTO customers(name,contact,phone,email,address) VALUES(?,?,?,?,?)').run(row.name,row.contact,row.phone,row.email,row.address);
}
for (const row of db.prepare('SELECT machine AS name FROM cases WHERE TRIM(machine) <> \'\' ORDER BY updated DESC,id DESC').all()) {
  if (!db.prepare('SELECT 1 FROM machines WHERE name = ? COLLATE NOCASE').get(row.name)) db.prepare('INSERT INTO machines(name,note) VALUES(?,\'\')').run(row.name);
}

function nowIso() { return new Date().toISOString(); }
function json(value) { return JSON.stringify(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function jsonArray(value) { try { const result = JSON.parse(value); return Array.isArray(result) ? result : []; } catch { return []; } }
function normalizeCaseStatus(value) { const status = String(value || 'new'); return CASE_STATUS_VALUES.has(status) ? status : LEGACY_CASE_STATUS_MAP[status] || 'new'; }
function defaultCurrentHandler(status) { return normalizeCaseStatus(status) === 'new' ? 'sales' : 'service'; }
function normalizeCurrentHandler(value, status) { return value === 'sales' || value === 'service' ? value : defaultCurrentHandler(status); }
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
for (const role of ['sales', 'service']) {
  const envName = `SERVICE_DESK_${role.toUpperCase()}_PASSWORD`;
  if (!setting(`${role}_password_hash`) && process.env[envName]) {
    if (process.env[envName].length < 8) throw new Error(`${envName} 至少需要 8 個字元。`);
    setSetting(`${role}_password_hash`, hashPassword(process.env[envName]));
  }
}

function readState() {
  const cases = db.prepare('SELECT * FROM cases ORDER BY updated DESC').all().map(row => ({
    id: row.id, customer: row.customer, machine: row.machine, contact: row.contact, phone: row.phone, email: row.email,
    address: row.address, warranty: row.warranty, orderNumber: row.order_number, manufacturedDate: row.manufactured_date,
    improvementUnit: row.improvement_unit, reportDate: row.report_date, serviceDate: row.service_date,
    owner: row.owner, status: normalizeCaseStatus(row.status), currentHandler: normalizeCurrentHandler(row.current_handler, row.status), description: row.description, handling: row.handling, returnReason: row.return_reason,
    responsibility: jsonArray(row.responsibility), isTest: Boolean(row.is_test), updated: row.updated,
    categories: db.prepare('SELECT category_name FROM case_categories WHERE case_id = ? ORDER BY category_name').all(row.id).map(item => item.category_name),
    parts: db.prepare('SELECT sku,name,method,quantity,state FROM case_parts WHERE case_id = ? ORDER BY id').all(row.id),
    inquiries: db.prepare('SELECT id,asked_at AS askedAt,asker,respondent,question,answer,created_by_role AS createdByRole FROM case_inquiries WHERE case_id = ? ORDER BY asked_at,id').all(row.id)
  }));
  return {
    cases,
    categories: db.prepare('SELECT name,group_name AS "group",pending FROM categories ORDER BY name').all().map(row => ({ ...row, pending: Boolean(row.pending) })),
    groups: db.prepare('SELECT name,protected FROM category_groups ORDER BY protected DESC,name').all().map(row => ({ ...row, protected: Boolean(row.protected) })),
    parts: db.prepare('SELECT sku,name,method,note,active FROM parts ORDER BY sku').all().map(row => ({ ...row, active: Boolean(row.active) })),
    customers: db.prepare('SELECT name,contact,phone,email,address FROM customers ORDER BY name').all(),
    machines: db.prepare('SELECT name,note FROM machines ORDER BY name').all(),
    staff: db.prepare('SELECT name,role,active FROM staff ORDER BY active DESC,name').all().map(row => ({ ...row, active: Boolean(row.active) })),
    warrantyCards: db.prepare('SELECT number,customer,machine FROM warranty_cards ORDER BY customer,number').all(),
    responsibilityDepartments: db.prepare('SELECT name,active FROM responsibility_departments ORDER BY name').all().map(row => ({ ...row, active: Boolean(row.active) })),
    responsibilityReasons: db.prepare('SELECT department,name,active FROM responsibility_reasons ORDER BY department,name').all().map(row => ({ ...row, active: Boolean(row.active) }))
  };
}
function stateRevision() { return crypto.createHash('sha256').update(json(readState())).digest('hex'); }

function normalizeState(input) {
  if (!input || typeof input !== 'object') throw new Error('資料格式無效。');
  const keys = ['cases', 'categories', 'parts', 'customers', 'machines'];
  if (!keys.every(key => Array.isArray(input[key]))) throw new Error('備份資料缺少必要欄位。');
  const cases = input.cases.map(item => ({
      id: String(item.id || '').trim(), customer: String(item.customer || '').trim(), machine: String(item.machine || '').trim(),
      contact: String(item.contact || ''), phone: String(item.phone || ''), email: String(item.email || ''), address: String(item.address || ''), warranty: String(item.warranty || '').trim(),
      orderNumber: String(item.orderNumber || '').trim(), manufacturedDate: String(item.manufacturedDate || ''), improvementUnit: String(item.improvementUnit || '').trim(),
      reportDate: String(item.reportDate || ''), serviceDate: String(item.serviceDate || ''), owner: String(item.owner || ''), status: normalizeCaseStatus(item.status), currentHandler: normalizeCurrentHandler(item.currentHandler, item.status),
      description: String(item.description || ''), handling: String(item.handling || ''), returnReason: String(item.returnReason || ''), responsibility: Array.isArray(item.responsibility) ? item.responsibility.map(entry => ({ department: String(entry.department || '').trim(), reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String).filter(Boolean) : [] })).filter(entry => entry.department) : [], isTest: Boolean(item.isTest), updated: String(item.updated || nowIso()),
      categories: Array.isArray(item.categories) ? item.categories.map(String).filter(Boolean) : [],
      parts: Array.isArray(item.parts) ? item.parts.map(part => ({ sku: String(part.sku || ''), name: String(part.name || ''), method: String(part.method || ''), quantity: Math.max(1, Number(part.quantity) || 1), state: String(part.state || '待處理') })).filter(part => part.sku || part.name) : [],
      inquiries: Array.isArray(item.inquiries) ? item.inquiries.map(inquiry => ({ id: Number(inquiry.id) || null, askedAt: String(inquiry.askedAt || nowIso()), asker: String(inquiry.asker || ''), respondent: String(inquiry.respondent || ''), question: String(inquiry.question || ''), answer: String(inquiry.answer || ''), createdByRole: ['admin','sales','service'].includes(inquiry.createdByRole) ? inquiry.createdByRole : 'admin' })).filter(inquiry => inquiry.asker || inquiry.respondent || inquiry.question || inquiry.answer) : []
    })).map(item => { if (!item.id || !item.customer || !item.machine || !item.description) throw new Error('每筆案件都需要案號、客戶、機型與故障描述。'); return item; });
  const categories = input.categories.map(item => ({ name: String(item.name || '').trim(), group: String(item.group || '待確認').trim() || '待確認', pending: Boolean(item.pending) })).filter(item => item.name);
  const groupNames = new Set(['待確認', ...categories.map(item => item.group)]);
  const groups = (Array.isArray(input.groups) ? input.groups : []).map(item => ({ name: String(item.name || '').trim(), protected: Boolean(item.protected) })).filter(item => item.name);
  for (const name of groupNames) if (!groups.some(item => item.name === name)) groups.push({ name, protected: name === '待確認' });
  if (!groups.some(item => item.name === '待確認')) groups.push({ name: '待確認', protected: true });
  const owners = new Set(cases.map(item => item.owner).filter(Boolean));
  const staff = (Array.isArray(input.staff) ? input.staff : []).map(item => ({ name: String(item.name || '').trim(), role: item.role === 'sales' || (!item.role && owners.has(item.name)) ? 'sales' : 'service', active: item.active !== false })).filter(item => item.name);
  for (const owner of owners) if (!staff.some(item => item.name === owner)) staff.push({ name: owner, role: 'sales', active: true });
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
    customers: input.customers.map(item => ({ name: String(item.name || '').trim(), contact: String(item.contact || ''), phone: String(item.phone || ''), email: String(item.email || ''), address: String(item.address || '') })).filter(item => item.name),
    machines: input.machines.map(item => ({ name: String(item.name || '').trim(), note: String(item.note || '') })).filter(item => item.name),
    staff,
    warrantyCards: [...warrantyByNumber.values()],
    responsibilityDepartments: (Array.isArray(input.responsibilityDepartments) ? input.responsibilityDepartments : []).map(entry => ({ name: String(entry.name || '').trim(), active: entry.active !== false })).filter(entry => entry.name),
    responsibilityReasons: (Array.isArray(input.responsibilityReasons) ? input.responsibilityReasons : []).map(entry => ({ department: String(entry.department || '').trim(), name: String(entry.name || '').trim(), active: entry.active !== false })).filter(entry => entry.department && entry.name)
  };
}

function replaceState(input) {
  const state = normalizeState(input);
  const existingAttachments = db.prepare('SELECT id,case_id,original_name,stored_name,relative_path,mime_type,size,uploaded_at,uploaded_by FROM case_attachments').all();
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    db.exec('DELETE FROM case_attachments; DELETE FROM case_categories; DELETE FROM case_parts; DELETE FROM case_inquiries; DELETE FROM cases; DELETE FROM categories; DELETE FROM category_groups; DELETE FROM parts; DELETE FROM customers; DELETE FROM machines; DELETE FROM staff; DELETE FROM warranty_cards; DELETE FROM responsibility_reasons; DELETE FROM responsibility_departments;');
    const insertCase = db.prepare('INSERT INTO cases(id,customer,machine,contact,phone,email,address,warranty,order_number,manufactured_date,improvement_unit,report_date,service_date,owner,status,current_handler,description,handling,return_reason,responsibility,is_test,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertCategoryLink = db.prepare('INSERT INTO case_categories(case_id,category_name) VALUES(?,?)');
    const insertPartLink = db.prepare('INSERT INTO case_parts(case_id,sku,name,method,quantity,state) VALUES(?,?,?,?,?,?)');
    const insertInquiry = db.prepare('INSERT INTO case_inquiries(id,case_id,asked_at,asker,respondent,question,answer,created_by_role) VALUES(?,?,?,?,?,?,?,?)');
    for (const item of state.cases) {
      insertCase.run(item.id,item.customer,item.machine,item.contact,item.phone,item.email,item.address,item.warranty,item.orderNumber,item.manufacturedDate,item.improvementUnit,item.reportDate,item.serviceDate,item.owner,item.status,item.currentHandler,item.description,item.handling,item.returnReason,json(item.responsibility),item.isTest ? 1 : 0,item.updated);
      for (const category of item.categories) insertCategoryLink.run(item.id, category);
      for (const part of item.parts) insertPartLink.run(item.id,part.sku,part.name,part.method,part.quantity,part.state);
      for (const inquiry of item.inquiries) insertInquiry.run(inquiry.id,item.id,inquiry.askedAt,inquiry.asker,inquiry.respondent,inquiry.question,inquiry.answer,inquiry.createdByRole);
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
    const insertCustomer = db.prepare('INSERT INTO customers(name,contact,phone,email,address) VALUES(?,?,?,?,?)');
    for (const item of state.customers) insertCustomer.run(item.name,item.contact,item.phone,item.email,item.address);
    const insertMachine = db.prepare('INSERT INTO machines(name,note) VALUES(?,?)');
    for (const item of state.machines) insertMachine.run(item.name,item.note);
    const insertStaff = db.prepare('INSERT INTO staff(name,role,active) VALUES(?,?,?)');
    for (const item of state.staff) insertStaff.run(item.name,item.role,item.active ? 1 : 0);
    const insertWarranty = db.prepare('INSERT INTO warranty_cards(number,customer,machine) VALUES(?,?,?)');
    for (const item of state.warrantyCards) insertWarranty.run(item.number,item.customer,item.machine);
    const insertDepartment = db.prepare('INSERT INTO responsibility_departments(name,active) VALUES(?,?)');
    for (const item of state.responsibilityDepartments) insertDepartment.run(item.name,item.active ? 1 : 0);
    const insertReason = db.prepare('INSERT INTO responsibility_reasons(department,name,active) VALUES(?,?,?)');
    for (const item of state.responsibilityReasons) insertReason.run(item.department,item.name,item.active ? 1 : 0);
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
function scheduledBackupDate(date = new Date()) {
  const due = new Date(date);
  if (due.getHours() < 22) due.setDate(due.getDate() - 1);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
}
function runScheduledBackup(date = new Date()) {
  const dueDate = scheduledBackupDate(date);
  if (setting('last_scheduled_backup_date') >= dueDate) return false;
  makeDatabaseBackup();
  setSetting('last_scheduled_backup_date', dueDate);
  return true;
}

const sessions = new Map();
const failedLogins = new Map();
function cleanupSessions() { const cutoff = Date.now(); for (const [token, session] of sessions) if (session.expiresAt <= cutoff) sessions.delete(token); }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(pair => pair.length === 2).map(([key,...value]) => [key, decodeURIComponent(value.join('='))])); }
function sessionFrom(req) { cleanupSessions(); const token = parseCookies(req).service_desk_session; const session = token && sessions.get(token); return session && session.expiresAt > Date.now() ? session : null; }
function roleFrom(req) { return sessionFrom(req)?.role || 'guest'; }
function isAdmin(req) { return ['admin', 'sales'].includes(roleFrom(req)); }
function send(res, status, body, headers = {}) { const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers }); res.end(payload); }
function error(res, status, message) { send(res, status, { error: message }); }
function requireAdmin(req, res) { if (!isAdmin(req)) { error(res, 403, '需要管理者登入才能執行此操作。'); return false; } return true; }
function requireRole(req, res, ...roles) { if (!roles.includes(roleFrom(req))) { error(res, 403, '目前角色沒有此操作權限。'); return false; } return true; }
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

function caseRecord(id) { return db.prepare('SELECT * FROM cases WHERE id = ?').get(id); }
function caseJson(id) { return readState().cases.find(item => item.id === id); }
function transaction(work) {
  db.exec('BEGIN');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function caseDraft(input) {
  const state = normalizeState({ cases: [input], categories: [], parts: [], customers: [], machines: [] });
  return state.cases[0];
}
function validateWarranty(item) {
  if (!item.warranty) return;
  const card = db.prepare('SELECT customer,machine FROM warranty_cards WHERE LOWER(number) = LOWER(?)').get(item.warranty);
  if (card && (card.customer !== item.customer || card.machine !== item.machine)) throw new Error('保修卡已綁定其他客戶或機型。');
}
function validateSalesOwner(item, currentOwner = '') {
  if (!item.owner || item.owner !== currentOwner && !db.prepare('SELECT 1 FROM staff WHERE name=? AND active=1').get(item.owner)) throw new Error('請選擇啟用中的人員作為提案者。');
}
function syncCaseMasters(item) {
  const customer = db.prepare('SELECT name FROM customers WHERE name = ? COLLATE NOCASE').get(item.customer);
  if (customer) item.customer = customer.name;
  else db.prepare('INSERT INTO customers(name,contact,phone,email,address) VALUES(?,?,?,?,?)').run(item.customer,item.contact,item.phone,item.email,item.address);
  const machine = db.prepare('SELECT name FROM machines WHERE name = ? COLLATE NOCASE').get(item.machine);
  if (machine) item.machine = machine.name;
  else db.prepare('INSERT INTO machines(name,note) VALUES(?,\'\')').run(item.machine);
}
function saveBusinessFields(item) {
  validateWarranty(item);
  validateSalesOwner(item,caseRecord(item.id)?.owner);
  const previousCategories = new Set(db.prepare('SELECT category_name FROM case_categories WHERE case_id=?').all(item.id).map(row=>row.category_name));
  for (const name of item.categories) if (!previousCategories.has(name) && !db.prepare('SELECT 1 FROM categories WHERE name=?').get(name)) throw new Error(`問題類別「${name}」尚未由管理者建立。`);
  db.prepare('UPDATE cases SET customer=?,machine=?,contact=?,phone=?,email=?,address=?,warranty=?,order_number=?,manufactured_date=?,improvement_unit=?,report_date=?,owner=?,description=?,is_test=?,updated=? WHERE id=?')
    .run(item.customer,item.machine,item.contact,item.phone,item.email,item.address,item.warranty,item.orderNumber,item.manufacturedDate,item.improvementUnit,item.reportDate,item.owner,item.description,item.isTest ? 1 : 0,nowIso(),item.id);
  db.prepare('DELETE FROM case_categories WHERE case_id=?').run(item.id);
  const category = db.prepare('INSERT INTO case_categories(case_id,category_name) VALUES(?,?)');
  for (const name of [...new Set(item.categories)]) category.run(item.id,name);
  if (item.warranty) db.prepare('INSERT OR IGNORE INTO warranty_cards(number,customer,machine) VALUES(?,?,?)').run(item.warranty,item.customer,item.machine);
}
function saveServiceFields(id, input, currentStatus, currentHandler = '') {
  const serviceDate = String(input.serviceDate || '');
  const handling = String(input.handling || '');
  const status = normalizeCaseStatus(input.status || currentStatus);
  const handler = normalizeCurrentHandler(input.currentHandler || currentHandler, status);
  const parts = Array.isArray(input.parts) ? input.parts.map(part => ({ sku: String(part.sku || ''), name: String(part.name || ''), method: String(part.method || ''), quantity: Math.max(1, Number(part.quantity) || 1), state: String(part.state || '待處理') })).filter(part => part.sku || part.name) : [];
  db.prepare('UPDATE cases SET service_date=?,handling=?,status=?,current_handler=?,updated=? WHERE id=?').run(serviceDate,handling,status,handler,nowIso(),id);
  db.prepare('DELETE FROM case_parts WHERE case_id=?').run(id);
  const insert = db.prepare('INSERT INTO case_parts(case_id,sku,name,method,quantity,state) VALUES(?,?,?,?,?,?)');
  for (const part of parts) insert.run(id,part.sku,part.name,part.method,part.quantity,part.state);
}
function createBusinessCase(input) {
  const item = caseDraft({ ...input, status: 'new' });
  if (caseRecord(item.id)) throw new Error('案件編號已存在，請重新建立。');
  transaction(() => {
    syncCaseMasters(item);
    db.prepare('INSERT INTO cases(id,customer,machine,description,updated,status) VALUES(?,?,?,?,?,\'new\')').run(item.id,item.customer,item.machine,item.description,nowIso());
    saveBusinessFields(item);
    saveServiceFields(item.id,item,'new','sales');
  });
  return caseJson(item.id);
}
function updateBusinessCase(id, input) {
  const current = caseRecord(id);
  if (!current) throw new Error('找不到案件。');
  const item = caseDraft({ ...input, id, status: current.status });
  transaction(() => { syncCaseMasters(item); saveBusinessFields(item); saveServiceFields(id,item,current.status,current.current_handler); });
  return caseJson(id);
}
function updateServiceCase(id, input) {
  const current = caseRecord(id);
  if (!current) throw new Error('找不到案件。');
  transaction(() => saveServiceFields(id,input,current.status,current.current_handler));
  return caseJson(id);
}
function updateSharedCase(id, input) {
  const current = caseRecord(id);
  if (!current) throw new Error('找不到案件。');
  if (input.expectedUpdated && input.expectedUpdated !== current.updated) { const conflict = new Error('案件已由其他人更新，請重新載入後再修改。'); conflict.status = 409; throw conflict; }
  const item = caseDraft({ ...input, id, status: current.status, currentHandler: input.currentHandler || current.current_handler });
  transaction(() => {
    syncCaseMasters(item);
    saveBusinessFields(item);
    saveServiceFields(id,input,current.status,current.current_handler);
  });
  return caseJson(id);
}
const transitions = {
  submit: { from: ['new','processing'], to: 'processing', handler: 'service' },
  return_to_business: { from: ['processing'], to: 'processing', handler: 'sales' },
  send_for_confirmation: { from: ['processing'], to: 'processing', handler: 'sales' },
  close: { from: ['new','processing'], to: 'closed', handler: 'sales' },
  return_to_service: { from: ['processing'], to: 'processing', handler: 'service' },
  void: { from: ['new','processing'], to: 'void', handler: 'sales' }
};
function transitionCase(id, action, role, reason = '') {
  const current = caseRecord(id);
  if (!current) throw new Error('找不到案件。');
  if (action === 'close' && !['sales','admin'].includes(role)) { const denied = new Error('只有業務或管理者可以結案。'); denied.status = 403; throw denied; }
  const change = transitions[action];
  if (!change || !change.from.includes(normalizeCaseStatus(current.status))) throw new Error('目前案件狀態不允許這項操作。');
  const returnReason = action === 'return_to_service' ? String(reason || '') : action === 'submit' ? '' : current.return_reason;
  db.prepare('UPDATE cases SET status=?,current_handler=?,return_reason=?,updated=? WHERE id=?').run(change.to,change.handler || current.current_handler,returnReason,nowIso(),id);
  return caseJson(id);
}
function validatePerson(name, existingName = '') {
  if (name === '客戶' || name && name === existingName) return name;
  if (!db.prepare('SELECT 1 FROM staff WHERE name=? AND active=1').get(name)) throw new Error('請從啟用中的業務或售服人員清單選擇。');
  return name;
}
function saveInquiry(caseId, input, role, inquiryId = null) {
  if (!caseRecord(caseId)) throw new Error('找不到案件。');
  const existing = inquiryId ? db.prepare('SELECT * FROM case_inquiries WHERE id=? AND case_id=?').get(inquiryId,caseId) : null;
  if (inquiryId && !existing) throw new Error('找不到問答紀錄。');
  const asker = validatePerson(String(input.asker || ''), existing?.asker);
  const respondent = input.respondent ? validatePerson(String(input.respondent), existing?.respondent) : '';
  const question = String(input.question || '').trim();
  if (!question) throw new Error('請填寫問題或內部事項。');
  const answer = String(input.answer || '');
  const askedAt = String(input.askedAt || nowIso());
  if (existing) db.prepare('UPDATE case_inquiries SET asked_at=?,asker=?,respondent=?,question=?,answer=? WHERE id=?').run(askedAt,asker,respondent,question,answer,inquiryId);
  else inquiryId = Number(db.prepare('INSERT INTO case_inquiries(case_id,asked_at,asker,respondent,question,answer,created_by_role) VALUES(?,?,?,?,?,?,?)').run(caseId,askedAt,asker,respondent,question,answer,role).lastInsertRowid);
  return db.prepare('SELECT id,asked_at AS askedAt,asker,respondent,question,answer,created_by_role AS createdByRole FROM case_inquiries WHERE id=?').get(inquiryId);
}
function validateResponsibility(input, current = []) {
  if (!Array.isArray(input)) throw new Error('責任歸屬資料格式不正確。');
  if (input.length > 5) throw new Error('一筆案件最多只能新增 5 組責任歸屬。');
  const selections = new Map();
  input.forEach(entry => {
    const department = String(entry.department || '').trim();
    const wasSelected = current.some(item => item.department === department);
    if (!department || !db.prepare('SELECT 1 FROM responsibility_departments WHERE name=? AND active=1').get(department) && !wasSelected) throw new Error('責任部門未啟用或不存在。');
    const reasons = [...new Set((Array.isArray(entry.reasons) ? entry.reasons : []).map(String).map(reason => reason.trim()).filter(Boolean))];
    for (const reason of reasons) if (!db.prepare('SELECT 1 FROM responsibility_reasons WHERE department=? AND name=? AND active=1').get(department,reason) && !current.some(item => item.department === department && item.reasons.includes(reason))) throw new Error(`「${department}」沒有啟用的原因「${reason}」。`);
    if (!selections.has(department)) selections.set(department, new Set());
    for (const reason of reasons) selections.get(department).add(reason);
  });
  return [...selections].map(([department,reasons]) => ({ department, reasons:[...reasons] }));
}

function route(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true, service: 'service-desk', time: nowIso() });
  if (req.method === 'GET' && pathname === '/api/session') { const role = roleFrom(req); return send(res, 200, { authenticated: role !== 'guest', role }); }
  if (req.method === 'POST' && pathname === '/api/login') return readBody(req).then(body => {
    const address = req.socket.remoteAddress || 'unknown'; const attempt = failedLogins.get(address) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) return error(res, 429, '登入嘗試過於頻繁，請稍後再試。');
    const password = String(body.password || '');
    const role = ['admin','sales','service'].includes(body.role) ? body.role : 'admin';
    if (!verifyPassword(password, setting(`${role}_password_hash`))) {
      attempt.count += 1; if (attempt.count >= 5) { attempt.count = 0; attempt.blockedUntil = Date.now() + 60_000; } failedLogins.set(address, attempt);
      return setTimeout(() => error(res, 401, '此角色密碼不正確，或尚未設定。'), 350);
    }
    failedLogins.delete(address); const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, { role, expiresAt: Date.now() + SESSION_TTL_MS }); setSessionCookie(res, token); return send(res, 200, { authenticated: true, role });
  }).catch(e => error(res, 400, e.message));
  if (req.method === 'POST' && pathname === '/api/logout') { const token = parseCookies(req).service_desk_session; if (token) sessions.delete(token); setSessionCookie(res, '', 0); return send(res, 200, { authenticated: false, role: 'guest' }); }
  if (req.method === 'GET' && pathname === '/api/passwords') { if (!requireAdmin(req,res)) return; return send(res,200,{ data: { sales: Boolean(setting('sales_password_hash')), service: Boolean(setting('service_password_hash')) } }); }
  const passwordMatch = pathname.match(/^\/api\/passwords\/(sales|service)$/);
  if (passwordMatch && req.method === 'PUT') {
    if (!requireAdmin(req,res)) return;
    return readBody(req).then(body => {
      const password = String(body.password || '');
      if (password.length < 8) return error(res,400,'共用密碼至少需要 8 個字元。');
      setSetting(`${passwordMatch[1]}_password_hash`,hashPassword(password));
      for (const [token,session] of sessions) if (session.role === passwordMatch[1]) sessions.delete(token);
      return send(res,200,{ data: { updated: true } });
    }).catch(e => error(res,400,e.message));
  }
  if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, { data: readState(), revision: stateRevision() });
  if (req.method === 'GET' && pathname === '/api/test-data/count') { if (!requireAdmin(req, res)) return; return send(res, 200, { data: { cases: db.prepare('SELECT COUNT(*) AS count FROM cases WHERE is_test = 1').get().count } }); }
  if (req.method === 'DELETE' && pathname === '/api/test-data') { if (!requireAdmin(req, res)) return; return send(res, 200, { data: { deleted: deleteTestCases() } }); }
  if (req.method === 'PUT' && pathname === '/api/state') { if (!requireAdmin(req, res)) return; return readBody(req).then(body => {
    if (body.revision && body.revision !== stateRevision()) return error(res,409,'資料已由其他人更新，請重新載入後再修改。');
    const data = replaceState(body.data || body);
    return send(res,200,{ data, revision: stateRevision() });
  }).catch(e => error(res, 400, e.message)); }
  if (req.method === 'GET' && pathname === '/api/cases') return send(res, 200, { data: readState().cases });
  if (req.method === 'POST' && pathname === '/api/cases') {
    if (!requireRole(req,res,'sales','service','admin')) return;
    return readBody(req).then(body => send(res,201,{ data: createBusinessCase(body.data || body) })).catch(e => error(res,400,e.message));
  }
  const caseActionMatch = pathname.match(/^\/api\/cases\/([^/]+)\/(edit|business|service|transition|responsibility|inquiries)(?:\/(\d+))?$/);
  if (caseActionMatch) {
    const [,encodedId,action,inquiryId] = caseActionMatch;
    const id = decodeURIComponent(encodedId);
    const role = roleFrom(req);
    if (action === 'edit' && req.method === 'PUT') { if (!requireRole(req,res,'sales','service','admin')) return; return readBody(req).then(body => send(res,200,{ data: updateSharedCase(id,body.data || body) })).catch(e => error(res,e.status || 400,e.message)); }
    if (action === 'business' && req.method === 'PUT') { if (!requireRole(req,res,'sales','service','admin')) return; return readBody(req).then(body => send(res,200,{ data: updateBusinessCase(id,body.data || body) })).catch(e => error(res,400,e.message)); }
    if (action === 'service' && req.method === 'PUT') { if (!requireRole(req,res,'sales','service','admin')) return; return readBody(req).then(body => send(res,200,{ data: updateServiceCase(id,body.data || body) })).catch(e => error(res,400,e.message)); }
    if (action === 'transition' && req.method === 'POST') { if (!requireRole(req,res,'sales','service','admin')) return; return readBody(req).then(body => { try { return send(res,200,{ data: transitionCase(id,body.action,role,body.reason) }); } catch (e) { return error(res,e.status || 400,e.message); } }).catch(e => error(res,e.status || 400,e.message)); }
    if (action === 'responsibility' && req.method === 'PUT') {
      if (!requireRole(req,res,'sales','service','admin')) return;
      return readBody(req).then(body => {
        const current = caseRecord(id); if (!current) return error(res,404,'找不到案件。');
        if (current.status !== 'closed') return error(res,409,'結案後才能填寫責任歸屬。');
        const value = validateResponsibility(body.data || body,jsonArray(current.responsibility));
        db.prepare('UPDATE cases SET responsibility=?,updated=? WHERE id=?').run(json(value),nowIso(),id);
        return send(res,200,{ data: caseJson(id) });
      }).catch(e => error(res,400,e.message));
    }
    if (action === 'inquiries') {
      if (req.method === 'GET' && !inquiryId) return caseRecord(id) ? send(res,200,{ data: caseJson(id).inquiries }) : error(res,404,'找不到案件。');
      if (!requireRole(req,res,'sales','service','admin')) return;
      if (req.method === 'POST' && !inquiryId) return readBody(req).then(body => send(res,201,{ data: saveInquiry(id,body.data || body,role) })).catch(e => error(res,400,e.message));
      if (req.method === 'PUT' && inquiryId) {
        const existing = db.prepare('SELECT created_by_role FROM case_inquiries WHERE id=? AND case_id=?').get(Number(inquiryId),id);
        if (!existing) return error(res,404,'找不到問答紀錄。');
        return readBody(req).then(body => send(res,200,{ data: saveInquiry(id,body.data || body,role,Number(inquiryId)) })).catch(e => error(res,400,e.message));
      }
      if (req.method === 'DELETE' && inquiryId) {
        const existing = db.prepare('SELECT created_by_role FROM case_inquiries WHERE id=? AND case_id=?').get(Number(inquiryId),id);
        if (!existing) return error(res,404,'找不到問答紀錄。');
        db.prepare('DELETE FROM case_inquiries WHERE id=?').run(Number(inquiryId));
        return send(res,200,{ data: { deleted: true } });
      }
    }
  }
  const caseMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (caseMatch && req.method === 'GET') { const item = readState().cases.find(entry => entry.id === decodeURIComponent(caseMatch[1])); return item ? send(res, 200, { data: item }) : error(res, 404, '找不到案件。'); }
  if (caseMatch && req.method === 'DELETE') { if (!requireAdmin(req, res)) return; return deleteCase(decodeURIComponent(caseMatch[1])) ? send(res, 200, { data: { deleted: true } }) : error(res, 404, '找不到案件。'); }
  const attachmentCollectionMatch = pathname.match(/^\/api\/cases\/([^/]+)\/attachments$/);
  if (attachmentCollectionMatch && req.method === 'GET') { const caseId = decodeURIComponent(attachmentCollectionMatch[1]); if (!getCaseById(caseId)) return error(res, 404, '找不到案件。'); return send(res, 200, { data: listAttachments(caseId) }); }
  if (attachmentCollectionMatch && req.method === 'POST') {
    if (!requireRole(req,res,'admin','sales','service')) return;
    const caseId = decodeURIComponent(attachmentCollectionMatch[1]); const item = getCaseById(caseId); if (!item) return error(res, 404, '找不到案件。');
    const encodedName = String(req.headers['x-file-name'] || '附件'); let decodedName = encodedName; try { decodedName = decodeURIComponent(encodedName); } catch { /* keep the raw header when it is not URI encoded */ } const originalName = sanitizeFileName(decodedName); const mimeType = String(req.headers['x-file-type'] || req.headers['content-type'] || '');
    if (!allowedAttachment(originalName, mimeType)) return error(res, 400, '只允許上傳圖片或影片檔案。');
    return readRawBody(req, MAX_ATTACHMENT_BYTES).then(buffer => {
      const folder = attachmentFolderForCase(item); fs.mkdirSync(folder, { recursive: true });
      const storedName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${originalName}`; const filePath = path.join(folder, storedName); const relativePath = path.relative(ATTACHMENTS_DIR, filePath);
      fs.writeFileSync(filePath, buffer);
      try { const result = db.prepare('INSERT INTO case_attachments(case_id,original_name,stored_name,relative_path,mime_type,size,uploaded_at,uploaded_by) VALUES(?,?,?,?,?,?,?,?)').run(caseId, originalName, storedName, relativePath, mimeType, buffer.length, nowIso(), roleFrom(req)); return send(res, 201, { data: { id: result.lastInsertRowid, originalName, mimeType, size: buffer.length, uploadedAt: nowIso(), uploadedBy: roleFrom(req) } }); } catch (error) { fs.rmSync(filePath, { force: true }); throw error; }
    }).catch(e => error(res, 400, e.message));
  }
  const attachmentDownloadMatch = pathname.match(/^\/api\/cases\/([^/]+)\/attachments\/(\d+)$/);
  if (attachmentDownloadMatch && req.method === 'GET') {
    const caseId = decodeURIComponent(attachmentDownloadMatch[1]); const row = db.prepare('SELECT * FROM case_attachments WHERE id = ? AND case_id = ?').get(Number(attachmentDownloadMatch[2]), caseId); if (!row) return error(res, 404, '找不到附件。');
    const filePath = attachmentPath(row); if (!fs.existsSync(filePath)) return error(res, 404, '附件檔案不存在。'); const stat = fs.statSync(filePath); res.writeHead(200, { 'Content-Type': row.mime_type, 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`, 'Cache-Control': 'no-store' }); return fs.createReadStream(filePath).pipe(res);
  }
  if (attachmentDownloadMatch && req.method === 'DELETE') {
    if (!requireRole(req,res,'admin','sales','service')) return; const caseId = decodeURIComponent(attachmentDownloadMatch[1]); const row = db.prepare('SELECT * FROM case_attachments WHERE id = ? AND case_id = ?').get(Number(attachmentDownloadMatch[2]), caseId); if (!row) return error(res, 404, '找不到附件。'); const filePath = attachmentPath(row); fs.rmSync(filePath, { force: true }); db.prepare('DELETE FROM case_attachments WHERE id = ?').run(row.id); return send(res, 200, { data: { deleted: true } });
  }
  const openFolderMatch = pathname.match(/^\/api\/cases\/([^/]+)\/attachments\/open-folder$/);
  if (openFolderMatch && req.method === 'POST') {
    if (!requireRole(req,res,'admin','sales','service')) return; const caseId = decodeURIComponent(openFolderMatch[1]); const item = getCaseById(caseId); if (!item) return error(res, 404, '找不到案件。'); if (process.platform !== 'win32') return error(res, 501, '只有 Windows 伺服器可以使用開啟資料夾功能。'); const folder = attachmentFolderForCase(item); fs.mkdirSync(folder, { recursive: true }); try { const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }); child.unref(); return send(res, 200, { data: { opened: true } }); } catch (error) { return error(res, 500, `無法開啟伺服器資料夾：${error.message}`); }
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
  const exportMatch = pathname.match(/^\/api\/export\/(customers|faults|responsibility)$/);
  if (exportMatch && req.method === 'GET') {
    if (!requireRole(req,res,'admin','sales','service')) return;
    const allCases = readState().cases;
    const rawIds = parsed.searchParams.get('ids');
    const selectedIds = rawIds === null ? null : new Set(rawIds.split(',').filter(Boolean));
    if (selectedIds && (!selectedIds.size || [...selectedIds].some(id => !allCases.some(item => item.id === id)))) return error(res,400,'請選擇有效的案件。');
    const selected = selectedIds ? allCases.filter(item => selectedIds.has(item.id)) : allCases;
    let headers, rows, filename;
    if (exportMatch[1] === 'customers') {
      filename = '售服客戶資料.xlsx'; headers = ['客戶名稱','Email','地址'];
      const distinct = new Map();
      for (const item of selected) distinct.set(`${item.customer}\u0000${item.email}\u0000${item.address}`, [item.customer,item.email,item.address]);
      rows = [...distinct.values()];
    } else if (exportMatch[1] === 'faults') {
      filename = '售服故障資料.xlsx'; headers = ['案號','客戶','問題類別','零件料號','零件名稱','維護方法'];
      rows = selected.flatMap(item => (item.parts.length ? item.parts : [{}]).map(part => [item.id,item.customer,item.categories.join('、'),part.sku || '',part.name || '',part.method || '']));
    } else {
      filename = '售服責任歸屬.xlsx'; headers = ['案號','客戶','責任部門','責任原因'];
      rows = selected.flatMap(item => (item.responsibility.length ? item.responsibility : [{ department: '', reasons: [] }]).flatMap(entry => (entry.reasons.length ? entry.reasons : ['']).map(reason => [item.id,item.customer,entry.department,reason])));
    }
    const payload = xlsx(headers,rows);
    res.writeHead(200,{ 'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Content-Length':payload.length, 'Cache-Control':'no-store' });
    return res.end(payload);
  }
  if (req.method === 'GET' && pathname === '/api/backup') { if (!requireAdmin(req, res)) return; const file = makeDatabaseBackup(); return send(res, 200, backupPayload(), { 'Content-Disposition': `attachment; filename="service-desk-backup-${new Date().toISOString().slice(0,10)}.json"`, 'X-Database-Backup': path.basename(file) }); }
  if (req.method === 'POST' && pathname === '/api/restore') { if (!requireAdmin(req, res)) return; return readBody(req).then(body => { const payload = body?.format === 'service-desk-backup' ? body : body?.data; if (payload?.format !== 'service-desk-backup' || payload?.version !== 1 || !payload.data) throw new Error('這不是有效的售服系統備份檔。'); makeDatabaseBackup(); return send(res, 200, { data: replaceState(payload.data) }); }).catch(e => error(res, 400, e.message)); }
  if (pathname.startsWith('/api/')) return error(res, 404, '找不到 API。');
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, '不支援的 HTTP 方法。');
  const filePath = pathname === '/' ? path.join(ROOT, 'dist', 'index.html') : path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return error(res, 404, '找不到頁面。');
  const contentType = filePath.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
  const stat = fs.statSync(filePath); res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'no-store' }); if (req.method === 'HEAD') return res.end(); fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => { try { route(req, res); } catch (e) { console.error(e); error(res, 500, '伺服器發生未預期錯誤。'); } });
if (require.main === module) {
  const checkBackup = () => { try { if (runScheduledBackup()) console.log('已完成本機時間 22:00 的 SQLite 備份（含漏做補備份）。'); } catch (error) { console.error('每日 SQLite 備份失敗：', error.message); } };
  checkBackup();
  const dailyBackupTimer = setInterval(checkBackup, BACKUP_CHECK_MS);
  server.listen(PORT, HOST, () => console.log(`售服系統已啟動：http://${HOST}:${PORT}`));
  const shutdown = () => { clearInterval(dailyBackupTimer); db.close(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
module.exports = { db, server, route, readState, replaceState, normalizeState, scheduledBackupDate, runScheduledBackup };
