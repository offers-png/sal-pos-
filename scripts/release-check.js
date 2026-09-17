const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const readiness = JSON.parse(fs.readFileSync(path.join(root, 'release-readiness.json'), 'utf8'));
const errors = [];
if (!readiness.sellerName) errors.push('Seller business name is not set.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(readiness.supportEmail || '')) errors.push('Customer support email is not set.');
if (!readiness.signingPublisher) errors.push('Code-signing publisher is not set.');
const requiredChecks = ['cleanInstall', 'upgrade', 'scanner', 'receiptPrinter', 'cashDrawer', 'dualScreen', 'offlineSale', 'refund', 'backupRestore'];
const devices = readiness.hardwareEvidence || [];
if (!devices.length) errors.push('No physical pilot hardware has been verified.');
for (const [i, evidence] of devices.entries()) {
  if (!evidence.tester || !evidence.testedAt || !evidence.windowsVersion || !evidence.pcModel || !evidence.scannerModel || !evidence.printerModel || !evidence.drawerModel) errors.push(`Hardware record ${i + 1} lacks model/tester details.`);
  for (const check of requiredChecks) if (evidence.checks?.[check] !== 'pass') errors.push(`Hardware record ${i + 1}: ${check} is not passed.`);
  const file = path.resolve(root, evidence.reportFile || '');
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) errors.push(`Hardware record ${i + 1}: evidence report is missing.`);
}
if (errors.length) { console.error('Commercial release blocked:\n- ' + errors.join('\n- ')); process.exitCode = 1; }
else console.log('Seller details and hardware evidence are recorded. Signature and artifact verification must also pass before publication.');
