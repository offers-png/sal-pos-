const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-pos-test-'));
process.env.SAL_DB_PATH = path.join(directory, 'test.db');
const database = require('../database');
const transactions = require('../services/transactions');
const money = require('../services/money');
const { app } = require('../server');
let server, url, ownerCookie;
async function request(route, body, cookie = ownerCookie, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(url + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json();
  return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const saleBody = (extra = {}) => ({ idempotencyKey: crypto.randomUUID(), items: [{ barcode: 'A', qty: 1 }], paymentType: 'Cash', discountPercentage: 0, taxEnabled: false, total: 100, ...extra });
before(async () => {
  await database.initDatabase();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const setup = await request('/api/auth/setup', { username: 'owner', pin: '987654' }, null);
  assert.equal(setup.status, 200); ownerCookie = setup.cookie;
  await database.productRepo.create({ barcode: 'A', name: 'Product A', price: 100, stock: 100, taxable: true, ebt_eligible: false, age_restricted: true, min_age: 21, cost: 40, reorder_point: 7 });
  await database.productRepo.create({ barcode: 'B', name: 'Product B', price: 60, stock: 100, taxable: false, ebt_eligible: true });
});
after(async () => { await new Promise(resolve => server.close(resolve)); database.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test('local catalog, branding and low-stock status survive reopening the database', async () => {
  const created = await request('/api/products', { barcode: 'LOCAL', name: 'Local product', price: 2.5, stock: 2, reorder_point: 3 });
  assert.equal(created.data.saved_to, 'sqlite');
  assert.equal((await request('/api/settings', { store_name: 'Corner <Market>', store_phone: '555-0100' })).data.success, true);
  database.closeDatabase();
  assert.equal((await database.productRepo.getByBarcode('LOCAL')).price, 2.5);
  assert.ok((await request('/api/products/low-stock')).data.products.some(p => p.barcode === 'LOCAL'));
  assert.equal((await request('/api/eod-today')).data.store.store_phone, '555-0100');
  assert.equal((await request('/api/status')).data.productCount, 3);
  const removed = await fetch(url + '/api/products/sync-from-sheets', { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(removed.status, 404);
});

test('daily report default uses the local store date around UTC midnight', async () => {
  const ActualDate = Date, previousTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  global.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : ['2026-09-17T00:30:00Z'])); } };
  try { assert.equal((await request('/api/reports/daily')).data.date, '2026-09-16'); }
  finally { global.Date = ActualDate; if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; }
});
test('anonymous clients cannot read sensitive data or mutate products/users/backups', async () => {
  for (const route of ['/api/products', '/api/users', '/api/backup/download', '/api/settings']) assert.equal((await request(route, undefined, null)).status, 401);
  assert.equal((await request('/api/users', { username: 'evil', pin: '123456', role: 'owner' }, null)).status, 401);
  assert.equal((await request('/api/auth/setup', { username: 'again', pin: '123456' }, null)).status, 409);
});
test('static serving does not expose database, source, credentials or node_modules', async () => {
  for (const route of ['/database.js', '/sal-pos.db', '/package.json', '/sales.json', '/google-credentials.json', '/node_modules/sql.js/package.json']) assert.equal((await fetch(url + route)).status, 404);
  const page = await fetch(url + '/index.html'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /sha256-/);
  assert.equal((await fetch(url + '/vendor/purify.js')).status, 200);
});
test('CSRF and unexpected Host rejected', async () => {
  assert.equal((await fetch(url + '/api/settings', { headers: { Origin: 'https://attacker.example', Cookie: ownerCookie } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    require('node:http').get(url + '/api/settings', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
});
test('cashier cannot change settings or return funds; manager can', async () => {
  assert.equal((await request('/api/users', { username: 'cashier', pin: '234567', role: 'cashier' })).status, 200);
  const cashier = await request('/api/auth/login', { username: 'cashier', pin: '234567' }, null);
  assert.equal((await request('/api/settings', { store_name: 'hijack' }, cashier.cookie)).status, 403);
  assert.equal((await request('/api/sales/abc/return', {}, cashier.cookie)).status, 403);
  assert.equal((await request('/api/settings', { store_name: 'Test Store' })).status, 200);
});
test('sale commits stock and cents, retry returns same sale and does not decrement twice', async () => {
  const before = (await database.productRepo.getByBarcode('A')).stock;
  const body = saleBody();
  const first = await request('/api/sales', body);
  assert.equal(first.status, 200); assert.equal(first.data.tenders.Cash, 10000);
  const retry = await request('/api/sales', body);
  assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true);
  assert.equal((await database.productRepo.getByBarcode('A')).stock, before - 1);
  assert.equal((await request('/api/sales', { ...body, total: 90 })).status, 400);
});
test('reject negative/fractional quantities, altered price and stale total', async () => {
  for (const qty of [-1, 0, 0.5]) assert.equal((await request('/api/sales', saleBody({ items: [{ barcode: 'A', qty }] }))).status, 400);
  assert.equal((await request('/api/sales', saleBody({ total: -100 }))).status, 400);
  assert.equal((await request('/api/sales', saleBody({ items: [{ barcode: 'A', qty: 1, price: 1 }], total: 1 }))).status, 400);
});
test('discounted refund uses original paid amount, including original tax', async () => {
  const sold = await request('/api/sales', saleBody({ discountPercentage: 20, total: 80 }));
  assert.equal(sold.status, 200);
  const body = { idempotencyKey: crypto.randomUUID(), items: [{ lineId: '0', qty: 1 }], refundMethod: 'Cash' };
  const refunded = await request(`/api/sales/${sold.data.saleId}/return`, body);
  assert.equal(refunded.status, 200); assert.equal(refunded.data.refundAmount, 80);
  assert.equal((await request(`/api/sales/${sold.data.saleId}/return`, body)).data.duplicate, true);
  const taxed = await request('/api/sales', saleBody({ taxEnabled: true, total: 108.25 }));
  const result = await request(`/api/sales/${taxed.data.saleId}/return`, { ...body, idempotencyKey: crypto.randomUUID() });
  assert.equal(result.data.refundAmount, 108.25);
});
test('duplicate lines and concurrent return requests cannot over-refund', async () => {
  const sold = await request('/api/sales', saleBody());
  const body = { idempotencyKey: crypto.randomUUID(), items: [{ lineId: '0', qty: 1 }, { lineId: '0', qty: 1 }], refundMethod: 'Cash' };
  assert.equal((await request(`/api/sales/${sold.data.saleId}/return`, body)).status, 400);
  const replies = await Promise.all([1,2].map(() => request(`/api/sales/${sold.data.saleId}/return`, { ...body, idempotencyKey: crypto.randomUUID(), items: [{ lineId: '0', qty: 1 }] })));
  assert.deepEqual(replies.map(r => r.status).sort(), [200,400]);
});
test('split tenders reconcile and refunds reduce daily net and expected cash', async () => {
  const shift = await request('/api/shifts/open', { startingCash: 20 });
  assert.equal(shift.status, 200);
  const sold = await request('/api/sales', saleBody({ items: [{ barcode: 'A', qty: 1 }, { barcode: 'B', qty: 1 }], paymentType: 'EBT + Cash', total: 160 }));
  assert.deepEqual(sold.data.tenders, { EBT: 6000, Cash: 10000 });
  const refunded = await request(`/api/sales/${sold.data.saleId}/return`, { idempotencyKey: crypto.randomUUID(), items: [{ lineId: '0', qty: 1 }], refundMethod: 'Cash' });
  assert.equal(refunded.status, 200);
  const report = await request('/api/reports/x-report');
  assert.equal(report.data.data.totalSales, 60); assert.equal(report.data.data.cashSales, 0); assert.equal(report.data.data.ebtSales, 60);
  const closed = await request('/api/shifts/close', { shiftId: shift.data.shiftId, endingCash: 20 });
  assert.equal(closed.status, 200); assert.equal(closed.data.shift.expected_cash, 20); assert.equal(closed.data.shift.cash_variance, 0);
});
test('partial product sync preserves stock, cost and restrictions', async () => {
  const before = await database.productRepo.getByBarcode('A');
  await database.productRepo.update('A', { name: 'Updated A', price: 100, category: 'Other / Misc' });
  const after = await database.productRepo.getByBarcode('A');
  for (const field of ['stock','cost','age_restricted','min_age','reorder_point','ebt_eligible']) assert.equal(after[field], before[field]);
});
test('disk failure rolls back memory and keeps the previous database file', async () => {
  const previous = fs.readFileSync(process.env.SAL_DB_PATH);
  const before = (await database.productRepo.getByBarcode('A')).stock;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Error('simulated disk failure'); };
  try { await assert.rejects(transactions.sale(saleBody(), 1), /simulated disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal((await database.productRepo.getByBarcode('A')).stock, before);
  assert.deepEqual(fs.readFileSync(process.env.SAL_DB_PATH), previous);
});
test('inventory SQL failure rolls back inserted sale', async () => {
  const db = await database.getDb();
  db.run("CREATE TRIGGER fail_inventory BEFORE INSERT ON inventory_log BEGIN SELECT RAISE(ABORT, 'inventory failure'); END");
  const body = saleBody();
  await assert.rejects(transactions.sale(body, 1), /inventory failure/);
  assert.equal(await database.salesRepo.getById(body.idempotencyKey), null);
  (await database.getDb()).run('DROP TRIGGER fail_inventory'); database.saveDb();
});
test('restore validates database and replaces the live handle', async () => {
  const backup = fs.readFileSync(process.env.SAL_DB_PATH);
  await database.settingsRepo.set('store_name', 'Changed');
  await assert.rejects(database.restoreDatabase(Buffer.from('not a database')));
  assert.equal(await database.settingsRepo.get('store_name'), 'Changed');
  await database.restoreDatabase(backup);
  assert.equal(await database.settingsRepo.get('store_name'), 'Test Store');
  database.saveDb();
  assert.equal(await database.settingsRepo.get('store_name'), 'Test Store');
});
test('integer cents allocation and explicit product tax/EBT flags', () => {
  const quote = money.calculate([{ price: 0.1, qty: 3, taxable: true, ebt_eligible: true }], { paymentType: 'Cash', discountPercentage: 0, taxRate: 0.1 });
  assert.equal(quote.total, 0.33);
  const ebt = money.calculate([{ price: 1, qty: 1, taxable: true, ebt_eligible: true }], { paymentType: 'EBT', taxRate: 0.1 });
  assert.equal(ebt.total, 1);
  assert.throws(() => money.calculate([{ price: 1, qty: 1, ebt_eligible: false }], { paymentType: 'EBT' }));
});
test('legacy split amounts remain unallocated, never double-counted', async () => {
  const db = await database.getDb();
  const id = crypto.randomUUID();
  await database.salesRepo.create({ saleId: id, items: [], total: 123, paymentType: 'EBT + Cash', shiftId: 999 });
  const summary = transactions.summarize(db, 'shift_id = ?', [999]);
  assert.equal(summary.total_sales, 123); assert.equal(summary.unallocated_total, 123);
  assert.equal(summary.cash_total, 0); assert.equal(summary.ebt_total, 0);
});
test('explicit non-EBT flag overrides an eligible category on every product read', async () => {
  await database.productRepo.create({ barcode: 'EXCEPTION', name: 'Exception', price: 1, category: 'Grocery', ebt_eligible: false, taxable: false });
  assert.equal((await database.productRepo.getByBarcode('EXCEPTION')).ebt_eligible, false);
  assert.equal((await database.productRepo.getAll()).find(p => p.barcode === 'EXCEPTION').ebt_eligible, false);
  assert.equal((await request('/api/sales', saleBody({ items: [{ barcode: 'EXCEPTION', qty: 1 }], total: 1, paymentType: 'EBT' }))).status, 400);
});
test('local sale survives database reload without cloud services', async () => {
  const body = saleBody();
  assert.equal((await request('/api/sales', body)).status, 200);
  database.closeDatabase();
  const db = await database.getDb();
  assert.equal(transactions.rows(db, 'SELECT sale_id FROM sales WHERE sale_id = ?', [body.idempotencyKey]).length, 1);
  assert.equal((await request('/api/sales', body)).data.duplicate, true);
});
test('default PIN is gated, logout revokes cookies, last owner cannot be removed', async () => {
  const legacyId = await database.userRepo.create({ username: 'legacy', pin: '1234', role: 'cashier' });
  const login = await request('/api/auth/login', { username: 'legacy', pin: '1234' }, null);
  assert.equal(login.data.mustChangePin, true);
  assert.equal((await request('/api/products', undefined, login.cookie)).status, 403);
  await request('/api/auth/logout', {}, login.cookie);
  assert.equal((await request('/api/products', undefined, login.cookie)).status, 401);
  assert.equal((await request('/api/users/1', {}, ownerCookie, 'DELETE')).status, 500);
  assert.equal((await database.userRepo.getById(1)).active, 1);
  assert.ok(legacyId);
});
