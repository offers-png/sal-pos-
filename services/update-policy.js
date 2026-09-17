const fs = require('fs');
const path = require('path');

function configured(app, resourcesPath, pkg) {
  if (app.isPackaged) return !!resourcesPath && fs.existsSync(path.join(resourcesPath, 'app-update.yml'));
  const configs = pkg?.build?.publish;
  return (Array.isArray(configs) ? configs : [configs]).some(c => c?.provider && c.owner && !c.owner.includes('YOUR_'));
}

async function prepareInstall(database, cartCount) {
  if (cartCount > 0) throw Error('Finish or clear the current cart before installing an update.');
  if (await database.shiftRepo.getOpen()) throw Error('Close the register shift before installing an update.');
  const folder = path.join(path.dirname(database.dbPath), 'backups');
  fs.mkdirSync(folder, { recursive: true });
  return require('./backups').createBackup(folder, 'pre-update');
}
module.exports = { configured, prepareInstall };
