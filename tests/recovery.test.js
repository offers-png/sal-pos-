const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-recovery-test-'));
process.env.SAL_DB_PATH = path.join(directory, 'register.db');
const database = require('../database');
const backups = require('../services/backups');
const policy = require('../services/update-policy');
before(async () => {
  await database.initDatabase();
  await database.userRepo.create({ username: 'recovery-owner', pin: '765432', role: 'owner' });
  await database.productRepo.create({ barcode: '000123', name: 'Recovery product', price: 4, stock: 12 });
});
after(() => { database.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a forced process exit before database replacement preserves the previous committed data', async () => {
  const before = fs.readFileSync(database.dbPath);
  database.closeDatabase();
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const db = require(${JSON.stringify(path.join(__dirname, '../database'))});
    (async () => { await db.getDb(); fs.renameSync = () => process.exit(86); await db.settingsRepo.set('store_name', 'NOT COMMITTED'); })();
  `], { env: { ...process.env }, timeout: 30000, encoding: 'utf8' });
  assert.equal(child.status, 86, child.stderr);
  assert.deepEqual(fs.readFileSync(database.dbPath), before);
  assert.equal(await database.settingsRepo.get('store_name'), 'My Store');
  assert.equal((await database.productRepo.getByBarcode('000123')).stock, 12);
});

test('daily backup is durable, does not overwrite earlier backups, and restores employees/products/settings', async () => {
  const folder = path.join(directory, 'external-drive'); fs.mkdirSync(folder);
  await database.settingsRepo.set('auto_backup_path', folder);
  const first = await backups.scheduledBackup();
  assert.ok(fs.statSync(first.path).size > 0);
  assert.equal(await backups.scheduledBackup(), null);
  const second = await backups.createBackup(folder);
  assert.notEqual(first.path, second.path);
  await database.settingsRepo.set('store_name', 'Changed after backup');
  await database.productRepo.updateStock('000123', -3, 'test', 1);
  await database.restoreDatabase(fs.readFileSync(first.path));
  assert.equal(await database.settingsRepo.get('store_name'), 'My Store');
  assert.equal((await database.productRepo.getByBarcode('000123')).stock, 12);
  assert.ok(await database.userRepo.verifyPin('recovery-owner', '765432'));
});

test('missing backup drive fails clearly without damaging the live database', async () => {
  const before = fs.readFileSync(database.dbPath);
  await assert.rejects(backups.createBackup(path.join(directory, 'unplugged-drive')), /unavailable/);
  assert.deepEqual(fs.readFileSync(database.dbPath), before);
});

test('packaged update discovery uses app-update.yml rather than stripped build metadata', () => {
  assert.equal(policy.configured({ isPackaged: true }, directory, {}), false);
  fs.writeFileSync(path.join(directory, 'app-update.yml'), 'provider: github');
  assert.equal(policy.configured({ isPackaged: true }, directory, {}), true);
});

test('update preparation rejects an active cart/shift and creates a backup once closed', async () => {
  await assert.rejects(policy.prepareInstall(database, 1), /cart/);
  const shift = await database.shiftRepo.open(1, 20);
  await assert.rejects(policy.prepareInstall(database, 0), /shift/);
  await database.shiftRepo.close(shift, 1, 20, 'test');
  const result = await policy.prepareInstall(database, 0);
  assert.ok(fs.existsSync(result.path));
});

test('support report excludes employee and product content', async () => {
  const report = await require('../services/diagnostics').report();
  assert.equal(report.database.integrity, 'ok');
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /recovery-owner|765432|Recovery product|000123/);
});

test('an older schema upgrades with catalog and employee accounts preserved', async () => {
  const db = await database.getDb();
  db.run('ALTER TABLE products DROP COLUMN ebt_override');
  db.run('ALTER TABLE sales DROP COLUMN tenders');
  db.run('ALTER TABLE sales DROP COLUMN request_hash');
  db.run('ALTER TABLE returns DROP COLUMN request_hash');
  db.run('ALTER TABLE returns DROP COLUMN refund_tax');
  database.saveDb(); database.closeDatabase();
  await database.initDatabase();
  assert.equal((await database.productRepo.getByBarcode('000123')).price, 4);
  assert.ok(await database.userRepo.verifyPin('recovery-owner', '765432'));
  const upgraded = await database.getDb();
  const columns = upgraded.exec('PRAGMA table_info(sales)')[0].values.map(row => row[1]);
  assert.ok(columns.includes('tenders')); assert.ok(columns.includes('request_hash'));
  assert.ok(fs.existsSync(database.dbPath + '.pre-' + require('../package.json').version + '.db'));
});
