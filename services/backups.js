const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function createBackup(folder, type = 'manual') {
  const database = require('../database');
  const db = await database.getDb();
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Choose an absolute backup folder path.');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw Error('Backup folder is unavailable. Connect the backup drive and retry.');
  const filename = `sal-pos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.db`;
  const target = path.join(folder, filename), temporary = target + '.tmp';
  const snapshot = Buffer.from(db.export());
  try {
    fs.writeFileSync(temporary, snapshot, { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  db.run('INSERT INTO backups (filename, file_path, size_bytes, backup_type) VALUES (?, ?, ?, ?)', [filename, target, snapshot.length, type]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_backup_at', ?)", [new Date().toISOString()]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_backup_error', '')");
  database.saveDb();
  return { filename, path: target, size: snapshot.length };
}

async function scheduledBackup() {
  const { settingsRepo } = require('../database');
  const folder = await settingsRepo.get('auto_backup_path');
  const day = new Date().toLocaleDateString('en-CA');
  if (!folder || await settingsRepo.get('last_auto_backup_day') === day) return null;
  try {
    const result = await createBackup(folder, 'scheduled');
    await settingsRepo.set('last_auto_backup_day', day);
    return result;
  } catch (error) {
    await settingsRepo.set('last_backup_error', error.message);
    throw error;
  }
}
module.exports = { createBackup, scheduledBackup };
