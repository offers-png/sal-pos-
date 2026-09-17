const { app, BrowserWindow, ipcMain, dialog, screen, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let customerWindow;
let currentTheme = 'light';
let cartItemCount = 0;
let updateReady = false;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function isAutoUpdateConfigured() {
  return require('./services/update-policy').configured(app, process.resourcesPath, require('./package.json'));
}

async function installReadyUpdate() {
  if (!updateReady) throw Error('No downloaded update is ready.');
  await require('./services/update-policy').prepareInstall(require('./database'), cartItemCount);
  autoUpdater.quitAndInstall(false, true);
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('Skipping auto-updater in development mode');
    return;
  }

  if (!isAutoUpdateConfigured()) {
    console.log('Auto-update not configured.');
    return;
  }

  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  function sendStatus(msg) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-status', msg);
    }
    console.log('[updater]', msg);
  }

  autoUpdater.on('checking-for-update', () => {
    sendStatus('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    sendStatus(`Update available: v${info.version}`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Sal POS v${info.version} is available.\nWould you like to download and install it now?`,
      buttons: ['Download Now', 'Later'],
      defaultId: 1, cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate().catch(error => sendStatus('Download failed: ' + error.message));
        sendStatus('Downloading update...');
      }
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendStatus(`App is up to date (v${info.version})`);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    sendStatus(`Downloading: ${progressObj.percent.toFixed(1)}%`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progressObj.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    sendStatus(`Update v${info.version} ready to install`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready to Install',
      message: `Sal POS v${info.version} downloaded.\nThe app will restart to install.`,
      buttons: ['Install after closing shift', 'Later'],
      defaultId: 1, cancelId: 1
    }).then(async (result) => {
      if (result.response === 0) {
        try { await installReadyUpdate(); }
        catch (error) { sendStatus(error.message); dialog.showMessageBox(mainWindow, { type: 'info', message: error.message, detail: 'When ready, use Settings → Check for Updates to retry.' }); }
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    sendStatus('Update unavailable. You can continue using the register offline.');
  });

  // Check on startup
  autoUpdater.checkForUpdates().catch(err => {
    console.error('[updater] Initial check failed:', err.message);
  });

  // Then every 4 hours silently
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[updater] Periodic check failed:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

function setupPaths() {
  const userData = app.getPath('userData');

  process.env.SAL_DB_PATH = path.join(userData, 'sal-pos.db');
  process.env.SAL_IS_PACKAGED = app.isPackaged ? 'true' : 'false';

  if (app.isPackaged) {
    process.env.SAL_SQLJS_DIR = process.resourcesPath;
    process.env.SAL_STATIC_DIR = app.getAppPath();
    process.env.SAL_RESOURCES_DIR = process.resourcesPath;
  } else {
    process.env.SAL_SQLJS_DIR = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
    process.env.SAL_STATIC_DIR = __dirname;
    process.env.SAL_RESOURCES_DIR = __dirname;
  }

  process.env.SAL_MARKETING_DIR = path.join(userData, 'marketing-images');
  fs.mkdirSync(process.env.SAL_MARKETING_DIR, { recursive: true });

  console.log('Database path:', process.env.SAL_DB_PATH);
  console.log('SQL.js directory:', process.env.SAL_SQLJS_DIR);
  console.log('Static directory:', process.env.SAL_STATIC_DIR);
  console.log('Resources directory:', process.env.SAL_RESOURCES_DIR);
}

async function waitForServer(url, maxAttempts = 30) {
  const http = require('http');
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          resolve(true);
        });
        req.on('error', reject);
        req.setTimeout(500, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    autoHideMenuBar: true
  });

  mainWindow.loadURL('http://127.0.0.1:5000');

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (customerWindow) {
      customerWindow.close();
    }
  });
}

function getMarketingImages() {
  const marketingDir = process.env.SAL_MARKETING_DIR;

  try {
    if (!fs.existsSync(marketingDir)) {
      console.log('Marketing images folder not found:', marketingDir);
      return [];
    }

    const files = fs.readdirSync(marketingDir);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    const images = files
      .filter(file => imageExtensions.includes(path.extname(file).toLowerCase()))
      .map(file => {
        const filePath = path.join(marketingDir, file);
        return 'http://127.0.0.1:5000/marketing-images/' + encodeURIComponent(file);
      });

    console.log('Found marketing images:', images.length);
    return images;
  } catch (err) {
    console.error('Error reading marketing images:', err.message);
    return [];
  }
}

function createCustomerDisplay() {
  if (customerWindow && !customerWindow.isDestroyed()) { customerWindow.show(); return; }
  const displays = screen.getAllDisplays();
  if (displays.length < 2) throw Error('Connect a second monitor and choose Extend in Windows display settings.');
  console.log('Available displays:', displays.length);

  let externalDisplay = displays.find(display => display.id !== screen.getDisplayMatching(mainWindow.getBounds()).id);

  if (!externalDisplay && displays.length > 1) {
    externalDisplay = displays[1];
  }

  const targetDisplay = externalDisplay || displays[0];
  console.log('Customer display on:', targetDisplay.bounds);

  customerWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  const customerDisplayPath = path.join(process.env.SAL_STATIC_DIR || __dirname, 'customer-display.html');
  customerWindow.loadURL('http://127.0.0.1:5000/customer-display.html');

  customerWindow.on('closed', () => {
    customerWindow = null;
  });

  customerWindow.webContents.on('did-finish-load', async () => {
    const settings = await require('./database').settingsRepo.getAll();
    if (!customerWindow || customerWindow.isDestroyed()) return;
    customerWindow.webContents.send('store-branding', { name: settings.store_name, phone: settings.store_phone });
    const images = getMarketingImages();
    customerWindow.webContents.send('marketing-images', images);
  });
}

if (hasInstanceLock) app.whenReady().then(async () => {
  setupPaths();

  try {
    const server = require('./server.js');
    await server.start();
    console.log('Server started successfully');
  } catch (err) {
    console.error('Failed to start server:', err);
    dialog.showErrorBox('Sal POS could not start', err.code === 'EADDRINUSE' ? 'Port 5000 is already in use. Close the other application and restart Sal POS.' : 'The local database could not be opened. Keep the database file and contact support. Details: ' + err.message);
    app.quit(); return;
  }

  const serverReady = await waitForServer('http://127.0.0.1:5000/api/products');
  if (serverReady) {
    // Apply the printer picked in the Hardware Setup wizard (Settings), if any.
    // Falls back to auto-detecting the OS default printer when nothing is saved.
    try {
      const savedPrinter = await require('./database').settingsRepo.get('printer_name');
      if (savedPrinter) {
        require('./printer').setPrinterName(savedPrinter);
        console.log('Loaded saved printer:', savedPrinter);
      }
    } catch (err) {
      console.warn('Could not load saved printer setting:', err.message);
    }

    console.log('Server is responding, creating window...');
    createWindow();
    setTimeout(() => {
      if (screen.getAllDisplays().length > 1) createCustomerDisplay();
    }, 1000);
  } else {
    dialog.showErrorBox('Sal POS could not start', 'The local register service did not respond. Restart Sal POS.');
    app.quit(); return;
  }

  setTimeout(() => {
    setupAutoUpdater();
  }, 3000);

  // === POWER MONITOR: restore scanner focus after sleep/wake or screen lock ===
  // visibilitychange / window.focus are unreliable in Electron after system sleep.
  // powerMonitor fires reliably in the main process — we send an IPC ping to the
  // renderer which then immediately restores focus to the barcode input.
  function sendWakeSignal(reason) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[powerMonitor] ${reason} — sending restore-focus to renderer`);
      // Bring window to front if it got buried
      if (!mainWindow.isFocused()) {
        mainWindow.focus();
      }
      // Small delay so OS finishes waking display before we steal focus
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('restore-focus');
        }
      }, 300);
    }
  }

  powerMonitor.on('resume', () => sendWakeSignal('resume'));
  powerMonitor.on('unlock-screen', () => sendWakeSignal('unlock-screen'));
  powerMonitor.on('user-did-become-active', () => sendWakeSignal('user-did-become-active'));

  // Force-save DB to disk before system sleeps so nothing is lost when
  // sql.js WASM memory gets paged out
  powerMonitor.on('suspend', () => {
    console.log('[powerMonitor] System suspending — flushing database to disk...');
    try {
      const { saveDb } = require('./database');
      saveDb();
      console.log('[powerMonitor] Database flushed OK');
    } catch (e) {
      console.error('[powerMonitor] DB flush failed:', e.message);
    }
  });

  // On resume: reload the renderer so it re-fetches all data fresh.
  // This is the most reliable fix for the blank UI after sleep — instead of
  // trying to recover state, we just let the page reinitialize cleanly.
  powerMonitor.on('resume', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[powerMonitor] System resumed — reloading renderer...');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 1500); // 1.5s delay so server has time to fully wake before reload
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC authority is based on the sending frame and server session, never renderer data.
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandle(channel, async (event, ...args) => {
  const source = new URL(event.senderFrame.url);
  if (source.origin !== 'http://127.0.0.1:5000') throw Error('Untrusted IPC sender');
  const publicChannels = ['request-current-theme', 'sync-theme', 'set-theme', 'get-app-version'];
  if (!publicChannels.includes(channel)) {
    const cookies = await event.sender.session.cookies.get({ url: source.origin });
    const response = await fetch(source.origin + '/api/auth/me', { headers: { Cookie: cookies.map(c => c.name + '=' + c.value).join('; ') } });
    const session = await response.json();
    if (!response.ok || session.mustChangePin) throw Error('Sign in first');
    if (['set-printer', 'add-marketing', 'remove-marketing', 'check-for-updates', 'export-diagnostics'].includes(channel) && !['owner', 'manager'].includes(session.user.role)) throw Error('Manager required');
  }
  return handler(event, ...args);
});
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:5000/')) event.preventDefault();
  });
});

ipcMain.handle('print-receipt', async (event, payload) => {
  try {
    const { printReceipt } = require('./printer');
    const openDrawer = false; // Checkout opens the drawer once; printing/reprinting never does.
    await new Promise(resolve => setTimeout(resolve, 300));
    await printReceipt(mainWindow, payload, openDrawer);
    return { ok: true };
  } catch (err) {
    console.error('Print error:', err.message);
    throw err;
  }
});

ipcMain.handle('complete-sale', async (event, payload) => {
  const { openCashDrawer } = require('./printer');
  let drawerWarning = null;

  if (payload.openDrawer !== false) {
    try {
      await openCashDrawer();
    } catch (err) {
      console.warn('Cash drawer failed (non-fatal):', err.message);
      drawerWarning = 'Cash drawer could not be opened';
    }
  }

  return { ok: true, warning: drawerWarning };
});

ipcMain.handle('open-drawer', async () => {
  try {
    const { openCashDrawer } = require('./printer');
    await openCashDrawer();
    return { ok: true };
  } catch (err) {
    console.error('Open drawer error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-printers', async () => {
  try {
    const { getAvailablePrinters, getPrinterName } = require('./printer');
    const printers = await getAvailablePrinters();
    return { ok: true, printers, currentPrinter: getPrinterName() };
  } catch (err) {
    console.error('Get printers error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-printer', async (event, printerName) => {
  try {
    const { setPrinterName } = require('./printer');
    setPrinterName(printerName);

    // Persist so the choice survives an app restart.
    await require('./database').settingsRepo.set('printer_name', printerName);

    return { ok: true };
  } catch (err) {
    console.error('Set printer error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('test-print', async () => {
  try {
    const { printReceipt } = require('./printer');
    await printReceipt(mainWindow, {
      store: { name: await require('./database').settingsRepo.get('store_name'), phone: await require('./database').settingsRepo.get('store_phone') },
      items: [{ name: 'Test Item', qty: 1, price: 1.00, total: 1.00 }],
      subtotal: 1.00,
      tax: 0,
      taxAmount: 0,
      total: 1.00,
      paymentType: 'Test Print',
      saleId: 'TEST-' + Date.now()
    }, false);
    return { ok: true };
  } catch (err) {
    console.error('Test print error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-for-updates', async () => {
  if (updateReady) {
    const answer = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'Install the downloaded update? Close the shift and clear the cart first.', buttons: ['Install', 'Later'], defaultId: 1, cancelId: 1 });
    if (answer.response === 0) await installReadyUpdate();
    return { ok: true };
  }
  if (!app.isPackaged) {
    return { ok: false, error: 'Updates only available in packaged app' };
  }
  if (!isAutoUpdateConfigured()) {
    return { ok: false, error: 'Auto-update not configured. Set GitHub publish config in package.json to enable updates.' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo };
  } catch (err) {
    console.error('Check for updates error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-app-version', async () => {
  return { version: app.getVersion() };
});

ipcMain.handle('update-customer-cart', async (event, cartData) => {
  if (event.sender === mainWindow?.webContents) cartItemCount = Array.isArray(cartData.items) ? cartData.items.length : 0;
  try {
    if (customerWindow && !customerWindow.isDestroyed()) {
      customerWindow.webContents.send('cart-update', cartData);
    }
    return { ok: true };
  } catch (err) {
    console.error('Customer cart update error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-theme', async (event, theme) => {
  try {
    currentTheme = theme;
    // Broadcast theme change to all windows
    const allWindows = BrowserWindow.getAllWindows();
    allWindows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('theme-changed', theme);
      }
    });
    return { ok: true };
  } catch (err) {
    console.error('Theme change error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('request-current-theme', async (event) => {
  try {
    event.sender.send('theme-changed', currentTheme);
    return { ok: true, theme: currentTheme };
  } catch (err) {
    console.error('Request theme error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sync-theme', async (event, theme) => {
  currentTheme = theme;
  return { ok: true };
});

function refreshMarketing() {
  if (customerWindow && !customerWindow.isDestroyed()) customerWindow.webContents.send('marketing-images', getMarketingImages());
}
ipcMain.handle('list-marketing', () => getMarketingImages().map(url => ({ name: decodeURIComponent(url.split('/').pop()), url })));
ipcMain.handle('add-marketing', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Add store marketing images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
  if (result.canceled) return { added: 0 };
  const sources = result.filePaths.map(source => {
    const ext = path.extname(source).toLowerCase();
    if (!['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(ext) || fs.statSync(source).size > 20 * 1024 * 1024) throw Error('Choose image files smaller than 20 MB.');
    return { source, ext };
  });
  for (const { source, ext } of sources) fs.copyFileSync(source, path.join(process.env.SAL_MARKETING_DIR, path.basename(source, ext).replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + require('crypto').randomUUID() + ext));
  refreshMarketing(); return { added: sources.length };
});
ipcMain.handle('remove-marketing', (_, name) => {
  if (typeof name !== 'string' || name !== path.basename(name) || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) throw Error('Invalid image');
  fs.unlinkSync(path.join(process.env.SAL_MARKETING_DIR, name)); refreshMarketing(); return { ok: true };
});
ipcMain.handle('show-customer-screen', () => { createCustomerDisplay(); return { ok: true }; });

ipcMain.handle('export-diagnostics', async () => {
  const data = await require('./services/diagnostics').report({
    displays: screen.getAllDisplays().map(d => ({ width: d.bounds.width, height: d.bounds.height, scaleFactor: d.scaleFactor })),
    printer: { configured: require('./printer').getPrinterName() || 'Windows default' },
    update: { configured: isAutoUpdateConfigured(), downloaded: updateReady }
  });
  const result = await dialog.showSaveDialog(mainWindow, { title: 'Save technical support report', defaultPath: 'sal-pos-diagnostics.json', filters: [{ name: 'JSON report', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2));
  return { saved: true };
});
