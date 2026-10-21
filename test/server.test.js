const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-desk-test-'));
const testPassword = 'x'.repeat(16);
process.env.SERVICE_DESK_ADMIN_PASSWORD = testPassword;
process.env.SERVICE_DESK_DATA_DIR = testDir;
process.env.SERVICE_DESK_BACKUP_DIR = path.join(testDir, 'backups');
process.env.SERVICE_DESK_ATTACHMENTS_DIR = path.join(testDir, 'attachments');
const app = require('../server');

function request(method, url, body, cookie = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { cookie, ...headers };
    req.socket = { remoteAddress: 'test-client' };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      setHeader(name, value) { this.headers[name] = value; },
      end(payload) { const text = String(payload || ''); let parsed = {}; try { parsed = JSON.parse(text || '{}'); } catch { parsed = text; } resolve({ status: this.status, headers: this.headers, body: parsed }); }
    };
    try {
      app.route(req, res);
      if (body !== undefined) process.nextTick(() => { req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))); req.emit('end'); });
    } catch (error) { reject(error); }
  });
}

test('health and guest reads are available while state writes require admin', async () => {
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const state = await request('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.data.cases, []);
  const denied = await request('PUT', '/api/state', { cases: [], categories: [], parts: [], customers: [], machines: [] });
  assert.equal(denied.status, 403);
});

test('admin login receives a session and can replace shared state', async () => {
  const login = await request('POST', '/api/login', { password: testPassword });
  assert.equal(login.status, 200);
  const cookie = String(login.headers['Set-Cookie']).split(';')[0];
  const state = { cases: [
    { id: 'SV-20261020-001', customer: '測試客戶', machine: 'MX-1', warranty: 'WC-001', orderNumber: 'SO-2026-001', manufacturedDate: '2024-03-15', improvementUnit: '組裝課', reportDate: '2026-10-20', description: '測試故障', updated: new Date().toISOString(), categories: ['異音'], inquiries: [{ askedAt: '2026-10-20T09:00:00.000Z', asker: 'A業務', respondent: 'B現場人員', question: '詢問故障原因', answer: '第一次回覆' }], parts: [] },
    { id: 'SV-TEST-001', customer: '測試客戶', machine: 'MX-1', warranty: 'WC-001', reportDate: '2026-10-20', description: '標記測試案件', updated: new Date().toISOString(), isTest: true, categories: [], parts: [] }
  ], categories: [{ name: '異音', group: '機械', pending: false }], groups: [{ name: '待確認', protected: true }, { name: '機械', protected: false }], parts: [], customers: [{ name: '測試客戶', contact: '', phone: '', address: '' }], machines: [{ name: 'MX-1', note: '' }], staff: [{ name: 'A業務', active: true }, { name: 'B現場人員', active: true }], warrantyCards: [{ number: 'WC-001', customer: '測試客戶', machine: 'MX-1' }] };
  const write = await request('PUT', '/api/state', state, cookie);
  assert.equal(write.status, 200);
  const item = await request('GET', '/api/cases/SV-20261020-001');
  assert.equal(item.status, 200);
  assert.equal(item.body.data.customer, '測試客戶');
  assert.deepEqual(item.body.data.categories, ['異音']);
  assert.equal(item.body.data.inquiries[0].respondent, 'B現場人員');
  assert.equal(item.body.data.isTest, false);
  assert.equal(item.body.data.orderNumber, 'SO-2026-001');
  assert.equal(item.body.data.manufacturedDate, '2024-03-15');
  assert.equal(item.body.data.improvementUnit, '組裝課');
  const cards = await request('GET', '/api/state');
  assert.deepEqual(cards.body.data.warrantyCards, [{ number: 'WC-001', customer: '測試客戶', machine: 'MX-1' }]);
  assert.throws(() => app.normalizeState({ ...state, cases: [...state.cases, { ...state.cases[0], id: 'SV-OTHER-001', customer: '其他客戶' }] }), /保修卡/);
  const groups = await request('GET', '/api/groups');
  assert.equal(groups.status, 200);
  assert.ok(groups.body.data.some(group => group.name === '機械'));
  const removeGroup = await request('DELETE', '/api/groups/%E6%A9%9F%E6%A2%B0', {}, cookie);
  assert.equal(removeGroup.status, 200);
  const afterGroupDelete = await request('GET', '/api/state');
  assert.equal(afterGroupDelete.body.data.cases[0].categories[0], '異音');
  assert.equal(afterGroupDelete.body.data.categories[0].group, '待確認');
  assert.equal(afterGroupDelete.body.data.groups.some(group => group.name === '機械'), false);
  const deleteCategory = await request('DELETE', '/api/categories/%E7%95%B0%E9%9F%B3', {}, cookie);
  assert.equal(deleteCategory.status, 200);
  assert.deepEqual((await request('GET', '/api/state')).body.data.cases[0].categories, []);
  const uploadDenied = await request('POST', '/api/cases/SV-20261020-001/attachments', Buffer.from('image'), '', { 'content-type': 'image/jpeg', 'x-file-name': '照片.jpg', 'x-file-type': 'image/jpeg' });
  assert.equal(uploadDenied.status, 403);
  const upload = await request('POST', '/api/cases/SV-20261020-001/attachments', Buffer.from('image'), cookie, { 'content-type': 'image/jpeg', 'x-file-name': '照片.jpg', 'x-file-type': 'image/jpeg' });
  assert.equal(upload.status, 201);
  const testUpload = await request('POST', '/api/cases/SV-TEST-001/attachments', Buffer.from('test-image'), cookie, { 'content-type': 'image/jpeg', 'x-file-name': '測試照片.jpg', 'x-file-type': 'image/jpeg' });
  assert.equal(testUpload.status, 201);
  state.cases[0].handling = '已確認附件索引不會因資料儲存消失';
  const rewrite = await request('PUT', '/api/state', state, cookie);
  assert.equal(rewrite.status, 200);
  const attachments = await request('GET', '/api/cases/SV-20261020-001/attachments');
  assert.equal(attachments.status, 200);
  assert.equal(attachments.body.data.length, 1);
  const folder = path.join(testDir, 'attachments', '測試客戶_2026-10-20_SV-20261020-001');
  assert.equal(fs.existsSync(folder), true);
  const guestCleanup = await request('DELETE', '/api/test-data', {});
  assert.equal(guestCleanup.status, 403);
  const testCount = await request('GET', '/api/test-data/count', undefined, cookie);
  assert.equal(testCount.body.data.cases, 1);
  const cleaned = await request('DELETE', '/api/test-data', {}, cookie);
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.body.data.deleted, 1);
  assert.deepEqual((await request('GET', '/api/cases')).body.data.map(entry=>entry.id), ['SV-20261020-001']);
  assert.equal(fs.existsSync(folder), true);
  assert.equal(fs.existsSync(path.join(testDir, 'attachments', '測試客戶_2026-10-20_SV-TEST-001')), false);
  const deleted = await request('DELETE', '/api/cases/SV-20261020-001', {}, cookie);
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(folder), false);
});

test.after(() => { app.db.close(); fs.rmSync(testDir, { recursive: true, force: true }); });
