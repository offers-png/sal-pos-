const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
function page(name, fetchHandler) {
  const html = fs.readFileSync(path.join(root, name), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:5000/' + name, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.fetch = fetchHandler; w.Headers = Headers; w.Response = Response;
  w.sessionStorage.setItem('user', JSON.stringify({ id: 1, username: 'owner', role: 'owner' }));
  const context = dom.getInternalVMContext();
  const run = source => new vm.Script(source).runInContext(context);
  run(fs.readFileSync(require.resolve('dompurify/dist/purify.min.js'), 'utf8'));
  for (const file of ['services/browser.js', 'services/money.js', 'services/receiptService.js', 'services/eodReportsService.js']) run(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) run(match[1]);
  return { dom, w, run };
}
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('daily print failure keeps retry available and uses configured store branding', async () => {
  const { dom, w, run } = page('index.html', async url => {
    if (url === '/api/eod-today') return reply({ success: true, store: { store_name: 'Corner <Market>', store_phone: '555-0100' }, totals: {}, counts: {} });
    return reply({ success: true, products: [], settings: {}, reports: [] });
  });
  try {
    await new Promise(r => setTimeout(r, 20));
    let fail = true, printed = '';
    w.electronAPI = { printReceipt: async payload => { if (fail) throw Error('Printer offline'); printed = payload.html; return { ok: true }; } };
    assert.equal(await run('autoGenerateAndPrintEod()'), false);
    assert.equal(w.localStorage.getItem('lastAutoPrintDate'), null);
    fail = false;
    assert.equal(await run('autoGenerateAndPrintEod()'), true);
    assert.ok(w.localStorage.getItem('lastAutoPrintDate'));
    assert.match(printed, /Corner &lt;Market&gt;/);
    assert.match(printed, /555-0100/);
  } finally { dom.window.close(); }
});

test('settings shows local product count and has no cloud sync controls', async () => {
  const { dom, w } = page('settings.html', async url => reply(url === '/api/status' ? { success: true, productCount: 42 } : { success: true, settings: {}, users: [], transactionCount: 0 }));
  try {
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.document.getElementById('productsCount').textContent, '42');
    assert.equal(w.document.getElementById('storageStatus').textContent, 'Local database ready');
    assert.equal(w.document.getElementById('syncBtn'), null);
    assert.ok(w.document.getElementById('addMarketingBtn'));
  } finally { dom.window.close(); }
});
test('register preserves failed checkout, retries same key, shows stored receipt ID', async () => {
  const requests = [];
  let fail = true;
  const { dom, w, run } = page('index.html', async (url, options) => {
    if (url === '/api/products') return reply({ success: true, products: [{ barcode: 'A', name: '<img src=x onerror="alert(1)"> A', price: 10, taxable: 1, ebt_eligible: false }] });
    if (url === '/api/settings') return reply({ success: true, settings: { tax_rate: '0.1' } });
    if (url === '/api/sales') {
      const body = JSON.parse(options.body); requests.push(body);
      if (fail) return reply({ success: false, error: 'Disk unavailable' }, 500);
      return reply({ success: true, saleId: body.idempotencyKey, items: body.items, subtotal: 10, discount: 0, tax: 1, total: 11, paymentType: 'Cash', tenders: { Cash: 1100 } });
    }
    return reply({ success: true, shift: null, reports: [] });
  });
  try {
    await new Promise(r => setTimeout(r, 50));
    run("cart = [{ barcode: 'A', name: 'A', price: 10, qty: 1, taxable: true, ebt_eligible: false }]; taxEnabled = true;");
    await run("completeSaleInstantly('Cash')");
    assert.equal(run('cart.length'), 1); assert.ok(w.localStorage.getItem('sal-pending-sale'));
    fail = false;
    await run("completeSaleInstantly('Cash')");
    assert.equal(run('cart.length'), 0);
    assert.equal(w.localStorage.getItem('sal-pending-sale'), null);
    assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
    assert.ok(w.document.body.textContent.includes('Receipt: ' + requests[0].idempotencyKey));
    run("showProductSearchResults(PRODUCTS, 'A')");
    assert.equal(w.document.querySelector('[onerror]'), null);
  } finally { dom.window.close(); }
});
test('double-click checkout posts only one request', async () => {
  let posts = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const { dom, run } = page('index.html', async (url, options) => {
    if (url === '/api/settings') return reply({ success: true, settings: { tax_rate: '0' } });
    if (url === '/api/products') return reply({ success: true, products: [] });
    if (url === '/api/sales') { posts++; await wait; const body = JSON.parse(options.body); return reply({ success: true, saleId: body.idempotencyKey, items: body.items, subtotal: 10, discount: 0, tax: 0, total: 10, paymentType: 'Cash', tenders: { Cash: 1000 } }); }
    return reply({ success: true });
  });
  try {
    await new Promise(r => setTimeout(r, 20));
    run("cart = [{name:'Manual',price:10,qty:1}]");
    const first = run("completeSaleInstantly('Cash')");
    const second = run("completeSaleInstantly('Cash')");
    await new Promise(r => setTimeout(r, 20)); release(); await Promise.all([first, second]);
    assert.equal(posts, 1);
  } finally { dom.window.close(); }
});
test('stored HTML is sanitized and static inline event attributes removed', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only', url: 'http://127.0.0.1:5000/index.html' });
  dom.window.fetch = async () => reply({});
  dom.window.eval(fs.readFileSync(require.resolve('dompurify/dist/purify.min.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(root, 'services/browser.js'), 'utf8'));
  const clean = dom.window.SafeHtml.clean('<img src=x onerror=alert(1)><script>alert(2)</script><svg onload=alert(3)>');
  assert.doesNotMatch(clean, /onerror|onload|<script/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /onclick="/);
  dom.window.close();
});
