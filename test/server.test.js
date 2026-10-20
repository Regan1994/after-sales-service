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
const app = require('../server');

function request(method, url, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { cookie };
    req.socket = { remoteAddress: 'test-client' };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      setHeader(name, value) { this.headers[name] = value; },
      end(payload) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(String(payload || '{}')) }); }
    };
    try {
      app.route(req, res);
      if (body !== undefined) process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
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
  const state = { cases: [{ id: 'SV-20261020-001', customer: '測試客戶', machine: 'MX-1', description: '測試故障', updated: new Date().toISOString(), categories: ['異音'], parts: [] }], categories: [{ name: '異音', group: '機械', pending: false }], parts: [], customers: [{ name: '測試客戶', contact: '', phone: '', address: '' }], machines: [{ name: 'MX-1', note: '' }] };
  const write = await request('PUT', '/api/state', state, cookie);
  assert.equal(write.status, 200);
  const item = await request('GET', '/api/cases/SV-20261020-001');
  assert.equal(item.status, 200);
  assert.equal(item.body.data.customer, '測試客戶');
  assert.deepEqual(item.body.data.categories, ['異音']);
});

test.after(() => { app.db.close(); fs.rmSync(testDir, { recursive: true, force: true }); });
