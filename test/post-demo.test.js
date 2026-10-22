const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-desk-workflow-'));
process.env.SERVICE_DESK_ADMIN_PASSWORD = 'admin-test-password';
process.env.SERVICE_DESK_SALES_PASSWORD = 'sales-test-password';
process.env.SERVICE_DESK_SERVICE_PASSWORD = 'service-test-password';
process.env.SERVICE_DESK_DATA_DIR = testDir;
process.env.SERVICE_DESK_BACKUP_DIR = path.join(testDir, 'backups');
process.env.SERVICE_DESK_ATTACHMENTS_DIR = path.join(testDir, 'attachments');
const app = require('../server');

async function api(method, url, body, cookie = '', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { cookie, ...(body === undefined ? {} : { 'content-type':Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }), ...extraHeaders };
    req.socket = { remoteAddress:'test-client' };
    const headers = {};
    const res = {
      writeHead(status, values) { this.status = status; Object.assign(headers, values); },
      setHeader(name, value) { headers[name] = value; },
      end(payload) {
        const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''));
        let data;
        try { data = JSON.parse(buffer.toString('utf8')); } catch { data = buffer; }
        resolve({ status:this.status, data, headers: { get(name) { return headers[name] || headers[Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())]; } } });
      }
    };
    try {
      app.route(req,res);
      if (body !== undefined) process.nextTick(() => { req.emit('data',Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))); req.emit('end'); });
    } catch (error) { reject(error); }
  });
}
async function login(role, password) {
  const response = await api('POST','/api/login',{ role, password });
  assert.equal(response.status,200);
  return response.headers.get('set-cookie').split(';')[0];
}
function zipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    entries.set(name,zlib.inflateRawSync(buffer.subarray(start,start + size)).toString('utf8'));
    offset = start + size;
  }
  return entries;
}

test.after(async () => {
  app.db.close();
  fs.rmSync(testDir,{ recursive:true,force:true });
});

test('shared case permissions, business administration, simplified workflow, exports, and scheduled backup', async () => {
  const admin = await login('admin','admin-test-password');
  const sales = await login('sales','sales-test-password');
  const service = await login('service','service-test-password');
  const initial = await api('GET','/api/state');
  const master = { ...initial.data.data,
    staff: [{ name:'王業務',role:'sales',active:true },{ name:'李售服',role:'service',active:true }],
    categories: [{ name:'異音',group:'待確認',pending:false }],
    responsibilityDepartments: [{ name:'品保',active:true },{ name:'製造',active:true }],
    responsibilityReasons: [{ department:'品保',name:'檢驗不足',active:true },{ department:'製造',name:'裝配疏失',active:true }]
  };
  assert.equal((await api('PUT','/api/state',{ ...master,revision:initial.data.revision },admin)).status,200);
  assert.equal((await api('PUT','/api/state',master,sales)).status,200);
  assert.equal((await api('PUT','/api/state',{ ...master,revision:initial.data.revision },admin)).status,409);

  const item = { id:'SV-20261021-001',customer:'甲客戶',machine:'MX-1',contact:'聯絡人',email:'customer@example.com',address:'台北',owner:'王業務',description:'運轉時異音',reportDate:'2026-10-21',categories:['異音'] };
  assert.equal((await api('POST','/api/cases',item,sales)).status,201);
  assert.equal((await api('POST','/api/cases',{ ...item,categories:['私自新增類別'] },sales)).status,400);
  assert.equal((await api('GET',`/api/cases/${item.id}`,undefined,sales)).data.data.status,'new');
  assert.equal((await api('GET',`/api/cases/${item.id}`,undefined,service)).data.data.status,'new');
  assert.equal((await api('GET',`/api/cases/${item.id}`,undefined,sales)).data.data.currentHandler,'sales');
  const stateAfterCreate = (await api('GET','/api/state')).data.data;
  assert.deepEqual(stateAfterCreate.customers,[{ name:'甲客戶',contact:'聯絡人',phone:'',email:'customer@example.com',address:'台北' }]);
  assert.deepEqual(stateAfterCreate.machines,[{ name:'MX-1',note:'' }]);
  const attachmentUrl = `/api/cases/${item.id}/attachments`;
  const attachmentHeaders = { 'x-file-name':'photo.png','x-file-type':'image/png' };
  assert.equal((await api('POST',attachmentUrl,Buffer.from('image'),'',attachmentHeaders)).status,403);
  const uploaded = await api('POST',attachmentUrl,Buffer.from('image'),service,attachmentHeaders);
  assert.equal(uploaded.status,201);
  assert.equal(uploaded.data.data.uploadedBy,'service');
  assert.equal((await api('DELETE',`${attachmentUrl}/${uploaded.data.data.id}`,{},sales)).status,200);
  assert.equal((await api('POST','/api/customers',{ name:'業務可新增' },sales)).status,200);
  assert.equal((await api('POST','/api/machines',{ name:'不應新增' },service)).status,403);
  assert.equal((await api('POST','/api/categories',{ name:'業務可新增',group:'待確認',pending:false },sales)).status,200);
  assert.equal((await api('POST','/api/parts',{ sku:'P-1',name:'不應新增' },service)).status,403);
  assert.equal((await api('POST','/api/staff',{ name:'業務可新增',role:'sales',active:true },sales)).status,200);
  assert.equal((await api('GET','/api/backup',undefined,sales)).status,200);
  assert.equal((await api('POST','/api/restore',{},service)).status,403);
  assert.equal((await api('PUT',`/api/cases/${item.id}/edit`,{ ...item,description:'修正後異音',handling:'初步檢查',status:'processing',currentHandler:'service',parts:[{ sku:'P-1',name:'軸承',method:'檢查',quantity:1 }] },sales)).status,200);
  assert.equal((await api('GET',`/api/cases/${item.id}`)).data.data.status,'processing');
  assert.equal((await api('GET',`/api/cases/${item.id}`)).data.data.currentHandler,'service');
  assert.equal((await api('PUT',`/api/cases/${item.id}/edit`,{ ...item,expectedUpdated:'舊版次' },service)).status,409);
  const serviceView = (await api('GET',`/api/cases/${item.id}`,undefined,service)).data.data;
  const serviceCustomerEdit = await api('PUT',`/api/cases/${item.id}/edit`,{ ...serviceView, customer:'不應修改的客戶', contact:'不應修改的聯絡人', expectedUpdated:serviceView.updated },service);
  assert.equal(serviceCustomerEdit.status,403);
  assert.equal((await api('GET',`/api/cases/${item.id}`,undefined,service)).data.data.customer,serviceView.customer);

  const inquiry = await api('POST',`/api/cases/${item.id}/inquiries`,{ asker:'王業務',question:'檢討德川精度檢驗表',answer:'' },sales);
  assert.equal(inquiry.status,201);
  assert.equal(inquiry.data.data.createdByRole,'sales');
  assert.equal((await api('PUT',`/api/cases/${item.id}/inquiries/${inquiry.data.data.id}`,{ asker:'王業務',respondent:'李售服',question:'檢討德川精度檢驗表',answer:'已檢查' },service)).status,200);
  const extraInquiry = await api('POST',`/api/cases/${item.id}/inquiries`,{ asker:'李售服',question:'內部確認' },service);
  assert.equal(extraInquiry.status,201);
  assert.equal((await api('DELETE',`/api/cases/${item.id}/inquiries/${extraInquiry.data.data.id}`,{},sales)).status,200);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'submit' },service)).status,200);
  assert.equal((await api('GET',`/api/cases/${item.id}`)).data.data.status,'processing');
  assert.equal((await api('PUT',`/api/cases/${item.id}/edit`,{ ...item,description:'修正後異音',handling:'更換軸承',status:'waiting',parts:[{ sku:'P-1',name:'軸承',method:'更換',quantity:1 }] },sales)).status,200);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'return_to_business' },sales)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/edit`,{ ...item,description:'再次修正',handling:'更換軸承',parts:[] },service)).status,200);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'submit' },sales)).status,200);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'send_for_confirmation' },sales)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/responsibility`,[{ department:'品保',reasons:['檢驗不足'] }],sales)).status,409);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'return_to_service',reason:'請再確認零件' },service)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/edit`,{ ...item,description:'再次修正',serviceDate:'2026-10-22',handling:'確認零件',status:'processing',parts:[] },sales)).status,200);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'send_for_confirmation' },service)).status,200);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'close' },service)).status,403);
  assert.equal((await api('POST',`/api/cases/${item.id}/transition`,{ action:'close' },sales)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/responsibility`,[{ department:'品保',reasons:['不存在'] }],sales)).status,400);
  assert.equal((await api('PUT',`/api/cases/${item.id}/responsibility`,[{ department:'品保',reasons:['檢驗不足'] },{ department:'製造',reasons:['裝配疏失'] }],service)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/responsibility`,Array.from({length:6},()=>({ department:'品保',reasons:['檢驗不足'] })),service)).status,400);
  const beforeDisable = await api('GET','/api/state');
  const disabled = { ...beforeDisable.data.data, responsibilityReasons:beforeDisable.data.data.responsibilityReasons.map(reason=>reason.name==='檢驗不足'?{ ...reason,active:false }:reason) };
  assert.equal((await api('PUT','/api/state',{ ...disabled,revision:beforeDisable.data.revision },admin)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/responsibility`,[{ department:'品保',reasons:['檢驗不足'] },{ department:'製造',reasons:['裝配疏失'] }],sales)).status,200);
  assert.equal((await api('PUT',`/api/cases/${item.id}/inquiries/${inquiry.data.data.id}`,{ asker:'王業務',respondent:'李售服',question:'檢討德川精度檢驗表',answer:'完成' },sales)).status,200);
  const saved = await api('GET',`/api/cases/${item.id}`);
  assert.equal(saved.data.data.description,'再次修正');
  assert.equal(saved.data.data.handling,'確認零件');
  assert.equal(saved.data.data.returnReason,'請再確認零件');
  assert.equal(saved.data.data.status,'closed');
  assert.equal(saved.data.data.currentHandler,'sales');
  assert.equal(saved.data.data.responsibility.length,2);

  for (const kind of ['customers','faults','responsibility']) {
    const response = await api('GET',`/api/export/${kind}?ids=${item.id}`,undefined,sales);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/spreadsheetml/);
    assert.equal(response.data.subarray(0,2).toString(),'PK');
    const sheet = zipEntries(response.data).get('xl/worksheets/sheet1.xml');
    assert.ok(sheet);
    if (kind==='customers') assert.match(sheet,/customer@example.com/);
    if (kind==='faults') assert.match(sheet,/異音/);
    if (kind==='responsibility') assert.match(sheet,/檢驗不足/);
  }
  assert.equal((await api('GET','/api/export/customers?ids=missing',undefined,sales)).status,400);
  assert.equal((await api('GET','/api/export/customers',undefined)).status,403);
  assert.equal((await api('DELETE',`/api/cases/${item.id}`,{},sales)).status,200);

  assert.equal(app.scheduledBackupDate(new Date(2026,9,21,21,0)),'2026-10-20');
  assert.equal(app.scheduledBackupDate(new Date(2026,9,21,22,0)),'2026-10-21');
  assert.equal(app.runScheduledBackup(new Date(2026,9,21,21,0)),true);
  assert.equal(app.runScheduledBackup(new Date(2026,9,21,21,1)),false);
  assert.equal(app.runScheduledBackup(new Date(2026,9,21,22,0)),true);
  assert.equal(fs.readdirSync(path.join(testDir,'backups')).filter(name=>name.endsWith('.sqlite')).length,3);
});
