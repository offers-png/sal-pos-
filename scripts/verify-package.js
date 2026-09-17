const fs = require('fs'), path = require('path'), crypto = require('crypto');
const asar = require('@electron/asar');
const root = path.join(__dirname, '..'), resources = path.join(root, 'dist/win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
const pkg = require('../package.json');
const bundled = JSON.parse(asar.extractFile(archive, 'package.json'));
if (bundled.version !== pkg.version) throw Error('Packaged version mismatch');
const forbidden = asar.listPackage(archive).filter(p => /googleapis|google-auth-library|credentials.*json|[.]db$|[\\/](products|sales)[.]json$/.test(p));
if (forbidden.length) throw Error('Packaged private data or removed integration: ' + forbidden.join(', '));
for (const filename of ['main.js', 'server.js', 'database.js', 'printer.js', 'preload.js', 'index.html', 'settings.html', 'reports.html', 'customer-display.html']) {
  if (!asar.extractFile(archive, filename).equals(fs.readFileSync(path.join(root, filename)))) throw Error('Packaged source mismatch: ' + filename);
}
if (!fs.existsSync(path.join(resources, 'sql-wasm.wasm'))) throw Error('SQLite runtime missing');
const update = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
if (!/provider: github/.test(update) || !/repo: sal-pos-\s/.test(update)) throw Error('Update feed configuration missing or incorrect');
const installer = path.join(root, 'dist', `Sal POS Setup ${pkg.version}.exe`);
const bytes = fs.readFileSync(installer);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(root, 'dist/SHA256SUMS.txt'), `${hash}  ${path.basename(installer)}\n`);
console.log('Package verified: source, version, SQLite, update feed, no embedded shop data. SHA256SUMS.txt generated.');
