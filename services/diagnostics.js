async function report(runtime = {}) {
  const { getDb } = require('../database');
  const db = await getDb();
  const counts = {};
  for (const table of ['products', 'sales', 'returns', 'users', 'shifts']) counts[table] = db.exec('SELECT COUNT(*) FROM ' + table)[0].values[0][0];
  return {
    generatedAt: new Date().toISOString(),
    appVersion: require('../package.json').version,
    platform: process.platform, architecture: process.arch, windowsVersion: require('os').release(),
    runtime: { electron: process.versions.electron || null, node: process.versions.node },
    database: { integrity: db.exec('PRAGMA integrity_check')[0].values[0][0], counts },
    ...runtime,
    privacy: 'Contains technical status and record counts, not product names, employee accounts, PINs, receipts, cookies or database contents.'
  };
}
module.exports = { report };
