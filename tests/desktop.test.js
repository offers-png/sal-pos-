const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function desktop(displays, role = 'cashier', selectedFiles = []) {
  const windows = [], handlers = new Map();
  class Window {
    constructor(options) { this.options = options; this.webContents = { on() {}, send() {} }; windows.push(this); }
    loadURL() {} on() {} show() {} isDestroyed() { return false; }
  }
  const electron = {
    app: { disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, requestSingleInstanceLock() { return true; }, whenReady() { return { then() {} }; }, on() {} },
    BrowserWindow: Window, ipcMain: { handle(name, fn) { handlers.set(name, fn); } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: selectedFiles }) },
    screen: { getAllDisplays() { return displays; }, getDisplayMatching() { return displays[0]; } }
  };
  const context = vm.createContext({ console, URL, Buffer, __dirname: path.join(__dirname, '..'), process: { env: {} }, require(name) {
    if (name === 'electron') return electron;
    if (name === 'electron-updater') return { autoUpdater: {} };
    return require(name);
  }, fetch: async () => ({ ok: true, json: async () => ({ user: { role } }) }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  vm.runInContext('mainWindow = { getBounds() { return {}; } };', context);
  return { context, windows, handlers };
}
test('customer display needs a second monitor and opens on the non-register monitor', () => {
  const first = { id: 1, bounds: { x: -1280, y: 0, width: 1280, height: 720 } };
  const single = desktop([first]);
  assert.throws(() => vm.runInContext('createCustomerDisplay()', single.context), /second monitor/);
  assert.equal(single.windows.length, 0);
  const dual = desktop([first, { id: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  vm.runInContext('createCustomerDisplay(); createCustomerDisplay();', dual.context);
  assert.equal(dual.windows.length, 1);
  assert.equal(dual.windows[0].options.x, 0);
});
test('cashiers cannot change marketing images through desktop IPC', async () => {
  const { handlers } = desktop([]);
  const event = { senderFrame: { url: 'http://127.0.0.1:5000/settings.html' }, sender: { session: { cookies: { get: async () => [] } } } };
  await assert.rejects(handlers.get('add-marketing')(event), /Manager required/);
  await assert.rejects(handlers.get('remove-marketing')(event, '../outside.png'), /Manager required/);
});

test('manager marketing uploads persist locally and reject deletion outside their folder', async () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sal-marketing-test-'));
  const source = path.join(directory, 'promotion.png'), images = path.join(directory, 'images');
  fs.writeFileSync(source, 'fixture'); fs.mkdirSync(images);
  const { context, handlers } = desktop([], 'owner', [source]);
  context.process.env.SAL_MARKETING_DIR = images;
  const event = { senderFrame: { url: 'http://127.0.0.1:5000/settings.html' }, sender: { session: { cookies: { get: async () => [] } } } };
  try {
    assert.equal((await handlers.get('add-marketing')(event)).added, 1);
    const list = await handlers.get('list-marketing')(event);
    assert.equal(list.length, 1);
    assert.equal(fs.readFileSync(path.join(images, list[0].name), 'utf8'), 'fixture');
    await assert.rejects(handlers.get('remove-marketing')(event, '../promotion.png'), /Invalid image/);
    assert.ok(fs.existsSync(source));
    await handlers.get('remove-marketing')(event, list[0].name);
    assert.equal((await handlers.get('list-marketing')(event)).length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
