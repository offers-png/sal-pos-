const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function loadPrinter(fail = false) {
  const written = new Map(), calls = [];
  const context = {
    module: { exports: {} }, Buffer, process: { platform: 'win32', env: {} }, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'electron') return { BrowserWindow: class {} };
      if (name === 'fs') return { writeFileSync(file, data) { written.set(file, data); }, unlinkSync() {} };
      if (name === 'child_process') return { execFileSync(exe, args) { calls.push({ exe, args }); if (fail) throw Error('spooler unavailable'); } };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../printer.js'), 'utf8'), context);
  return { api: context.module.exports, written, calls };
}
test('printer names are passed as data and child process uses argument array', async () => {
  const { api, written, calls } = loadPrinter();
  const name = "Shop's printer'; unexpected-command #";
  api.setPrinterName(name);
  await api.openCashDrawer();
  const script = [...written.entries()].find(([file]) => file.endsWith('.ps1'))[1];
  assert.ok(script.includes(Buffer.from(name).toString('base64')));
  assert.ok(!script.includes('unexpected-command'));
  assert.equal(calls[0].exe, 'powershell.exe');
  assert.ok(Array.isArray(calls[0].args));
  assert.match(script, /throw 'Printer rejected/);
});
test('drawer failures propagate to checkout warning instead of reporting success', async () => {
  const { api } = loadPrinter(true);
  api.setPrinterName('Test');
  await assert.rejects(api.openCashDrawer(), /spooler unavailable/);
});
