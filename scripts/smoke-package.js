const fs = require('fs'), path = require('path'), os = require('os');
if (!process.versions.electron) {
  const executable = path.resolve(__dirname, '../dist/win-unpacked/Sal POS.exe');
  const result = require('child_process').spawnSync(executable, [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, timeout: 45000
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const resources = path.resolve(__dirname, '../dist/win-unpacked/resources');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-package-smoke-'));
process.env.SAL_DB_PATH = path.join(directory, 'store.db');
process.env.SAL_SQLJS_DIR = resources;
process.env.SAL_STATIC_DIR = path.join(resources, 'app.asar');
process.env.SAL_RESOURCES_DIR = resources;
process.env.SAL_MARKETING_DIR = path.join(directory, 'marketing-images');
process.env.SAL_IS_PACKAGED = 'true';
fs.mkdirSync(process.env.SAL_MARKETING_DIR);
const watchdog = setTimeout(() => { console.error('Packaged smoke test timed out'); process.exit(1); }, 30000);
(async () => {
  const database = require(path.join(resources, 'app.asar/database.js'));
  const { start } = require(path.join(resources, 'app.asar/server.js'));
  const server = await start();
  try {
    const origin = 'http://127.0.0.1:5000';
    const login = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pilot_owner', pin: '938472' }) });
    if (!login.ok) throw Error('Owner setup failed');
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
    const catalog = await (await fetch(origin + '/api/products', { headers })).json();
    if (catalog.products.length) throw Error('New store must have an empty catalog');
    const response = await fetch(origin + '/api/products', { method: 'POST', headers, body: JSON.stringify({ barcode: '001234', name: 'Smoke product', price: 2.5, stock: 5 }) });
    if (!response.ok) throw Error('Local product save failed');
    database.closeDatabase();
    const saved = await database.productRepo.getByBarcode('001234');
    if (saved.price !== 2.5 || saved.stock !== 5) throw Error('Product did not survive database reload');
    if (!(await fetch(origin + '/settings.html')).ok) throw Error('Packaged Settings unavailable');
    const backup = await (await fetch(origin + '/api/backup', { method: 'POST', headers, body: '{}' })).json();
    if (!backup.success || !fs.existsSync(backup.path)) throw Error('Packaged backup failed');
    console.log('PACKAGED SMOKE PASSED: new owner, empty catalog, local save/reload, Settings and backup.');
  } finally { await new Promise(resolve => server.close(resolve)); database.closeDatabase(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  fs.rmSync(directory, { recursive: true, force: true });
});
