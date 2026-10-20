const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.SERVICE_DESK_PORT || 8080);
const HOST = process.env.SERVICE_DESK_HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.SERVICE_DESK_DATA_DIR || path.join(ROOT, 'data'));
const BACKUP_DIR = path.resolve(process.env.SERVICE_DESK_BACKUP_DIR || path.join(ROOT, 'backups'));
const DB_PATH = path.join(DATA_DIR, 'service-desk.sqlite');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const BACKUP_RETENTION = Math.max(7, Number(process.env.SERVICE_DESK_BACKUP_RETENTION || 30));
const DAILY_BACKUP_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
    report_date TEXT NOT NULL DEFAULT '',
    service_date TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    description TEXT NOT NULL DEFAULT '',
    handling TEXT NOT NULL DEFAULT '',
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
  CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases(updated);
  CREATE INDEX IF NOT EXISTS idx_case_categories_name ON case_categories(category_name);
  CREATE INDEX IF NOT EXISTS idx_case_parts_sku ON case_parts(sku);
`);

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
    address: row.address, warranty: row.warranty, reportDate: row.report_date, serviceDate: row.service_date,
    owner: row.owner, status: row.status, description: row.description, handling: row.handling, updated: row.updated,
    categories: db.prepare('SELECT category_name FROM case_categories WHERE case_id = ? ORDER BY category_name').all(row.id).map(item => item.category_name),
    parts: db.prepare('SELECT sku,name,method,quantity,state FROM case_parts WHERE case_id = ? ORDER BY id').all(row.id)
  }));
  return {
    cases,
    categories: db.prepare('SELECT name,group_name AS "group",pending FROM categories ORDER BY name').all().map(row => ({ ...row, pending: Boolean(row.pending) })),
    parts: db.prepare('SELECT sku,name,method,note,active FROM parts ORDER BY sku').all().map(row => ({ ...row, active: Boolean(row.active) })),
    customers: db.prepare('SELECT name,contact,phone,address FROM customers ORDER BY name').all(),
    machines: db.prepare('SELECT name,note FROM machines ORDER BY name').all()
  };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object') throw new Error('資料格式無效。');
  const keys = ['cases', 'categories', 'parts', 'customers', 'machines'];
  if (!keys.every(key => Array.isArray(input[key]))) throw new Error('備份資料缺少必要欄位。');
  return {
    cases: input.cases.map(item => ({
      id: String(item.id || '').trim(), customer: String(item.customer || '').trim(), machine: String(item.machine || '').trim(),
      contact: String(item.contact || ''), phone: String(item.phone || ''), address: String(item.address || ''), warranty: String(item.warranty || ''),
      reportDate: String(item.reportDate || ''), serviceDate: String(item.serviceDate || ''), owner: String(item.owner || ''), status: String(item.status || 'new'),
      description: String(item.description || ''), handling: String(item.handling || ''), updated: String(item.updated || nowIso()),
      categories: Array.isArray(item.categories) ? item.categories.map(String).filter(Boolean) : [],
      parts: Array.isArray(item.parts) ? item.parts.map(part => ({ sku: String(part.sku || ''), name: String(part.name || ''), method: String(part.method || ''), quantity: Math.max(1, Number(part.quantity) || 1), state: String(part.state || '待處理') })).filter(part => part.sku || part.name) : []
    })).map(item => { if (!item.id || !item.customer || !item.machine || !item.description) throw new Error('每筆案件都需要案號、客戶、機型與故障描述。'); return item; }),
    categories: input.categories.map(item => ({ name: String(item.name || '').trim(), group: String(item.group || '待確認'), pending: Boolean(item.pending) })).filter(item => item.name),
    parts: input.parts.map(item => ({ sku: String(item.sku || '').trim(), name: String(item.name || '').trim(), method: String(item.method || ''), note: String(item.note || ''), active: item.active !== false })).filter(item => item.sku && item.name),
    customers: input.customers.map(item => ({ name: String(item.name || '').trim(), contact: String(item.contact || ''), phone: String(item.phone || ''), address: String(item.address || '') })).filter(item => item.name),
    machines: input.machines.map(item => ({ name: String(item.name || '').trim(), note: String(item.note || '') })).filter(item => item.name)
  };
}

function replaceState(input) {
  const state = normalizeState(input);
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    db.exec('DELETE FROM case_categories; DELETE FROM case_parts; DELETE FROM cases; DELETE FROM categories; DELETE FROM parts; DELETE FROM customers; DELETE FROM machines;');
    const insertCase = db.prepare('INSERT INTO cases(id,customer,machine,contact,phone,address,warranty,report_date,service_date,owner,status,description,handling,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertCategoryLink = db.prepare('INSERT INTO case_categories(case_id,category_name) VALUES(?,?)');
    const insertPartLink = db.prepare('INSERT INTO case_parts(case_id,sku,name,method,quantity,state) VALUES(?,?,?,?,?,?)');
    for (const item of state.cases) {
      insertCase.run(item.id,item.customer,item.machine,item.contact,item.phone,item.address,item.warranty,item.reportDate,item.serviceDate,item.owner,item.status,item.description,item.handling,item.updated);
      for (const category of item.categories) insertCategoryLink.run(item.id, category);
      for (const part of item.parts) insertPartLink.run(item.id,part.sku,part.name,part.method,part.quantity,part.state);
    }
    const insertCategory = db.prepare('INSERT INTO categories(name,group_name,pending) VALUES(?,?,?)');
    for (const item of state.categories) insertCategory.run(item.name,item.group,item.pending ? 1 : 0);
    const insertPart = db.prepare('INSERT INTO parts(sku,name,method,note,active) VALUES(?,?,?,?,?)');
    for (const item of state.parts) insertPart.run(item.sku,item.name,item.method,item.note,item.active ? 1 : 0);
    const insertCustomer = db.prepare('INSERT INTO customers(name,contact,phone,address) VALUES(?,?,?,?)');
    for (const item of state.customers) insertCustomer.run(item.name,item.contact,item.phone,item.address);
    const insertMachine = db.prepare('INSERT INTO machines(name,note) VALUES(?,?)');
    for (const item of state.machines) insertMachine.run(item.name,item.note);
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
function readBody(req) { return new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) { reject(new Error('上傳檔案過大。')); req.destroy(); return; } chunks.push(chunk); }); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('請提供有效的 JSON 資料。')); } }); req.on('error', reject); }); }
function backupPayload() { return { format: 'service-desk-backup', version: 1, exportedAt: nowIso(), data: readState() }; }
function setSessionCookie(res, token, maxAge = SESSION_TTL_MS / 1000) { res.setHeader('Set-Cookie', `service_desk_session=${encodeURIComponent(token)}; Max-Age=${Math.floor(maxAge)}; Path=/; HttpOnly; SameSite=Lax`); }
function resourceItems(state, resource) { const map = { cases: 'cases', categories: 'categories', parts: 'parts', customers: 'customers', machines: 'machines' }; return map[resource] ? state[map[resource]] : null; }
function resourceKey(resource, item) { return resource === 'cases' ? item.id : resource === 'parts' ? item.sku : item.name; }

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
  if (req.method === 'PUT' && pathname === '/api/state') { if (!requireAdmin(req, res)) return; return readBody(req).then(body => send(res, 200, { data: replaceState(body.data || body) })).catch(e => error(res, 400, e.message)); }
  if (req.method === 'GET' && pathname === '/api/cases') return send(res, 200, { data: readState().cases });
  const caseMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (caseMatch && req.method === 'GET') { const item = readState().cases.find(entry => entry.id === decodeURIComponent(caseMatch[1])); return item ? send(res, 200, { data: item }) : error(res, 404, '找不到案件。'); }
  const resourceMatch = pathname.match(/^\/api\/(cases|categories|parts|customers|machines)(?:\/([^/]+))?$/);
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
        if (resource === 'categories' && state.cases.some(item => (item.categories || []).includes(key))) return error(res, 409, '此問題類別仍被案件使用，無法刪除。');
        if (resource === 'parts' && state.cases.some(item => (item.parts || []).some(part => part.sku === key))) return error(res, 409, '此零件仍被案件使用，無法刪除。');
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
