const { app, BrowserWindow, ipcMain, dialog, screen, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let customerWindow;
let currentTheme = 'light';

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function isAutoUpdateConfigured() {
  try {
    const pkg = require('./package.json');
    const publish = pkg.build?.publish;
    
    if (!publish) return false;
    
    const configs = Array.isArray(publish) ? publish : [publish];
    
    return configs.some(cfg => {
      if (!cfg || typeof cfg !== 'object') return false;
      return cfg.provider && cfg.owner && !String(cfg.owner).includes('YOUR_');
    });
  } catch {
    return false;
  }
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
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    sendStatus(`Update v${info.version} ready to install`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready to Install',
      message: `Sal POS v${info.version} downloaded.\nThe app will restart to install.`,
      buttons: ['Restart & Install Now', 'Install on Next Restart'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    if (!err.message.includes('net::') && !err.message.includes('ENOTFOUND')) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Update Error',
        message: `Update check failed: ${err.message}`,
        buttons: ['OK']
      });
    }
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
app.commandLine.appendSwitch('no-sandbox');

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
  
  const seedDb = app.isPackaged 
    ? path.join(process.resourcesPath, 'sal-pos.db')
    : path.join(__dirname, 'sal-pos.db');
    
  if (!fs.existsSync(process.env.SAL_DB_PATH) && fs.existsSync(seedDb)) {
    console.log('Copying seed database to userData...');
    fs.copyFileSync(seedDb, process.env.SAL_DB_PATH);
  }
  
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
      contextIsolation: true
    },
    autoHideMenuBar: true
  });

  mainWindow.loadURL('http://localhost:5000');

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (customerWindow) {
      customerWindow.close();
    }
  });
}

function getMarketingImages() {
  const marketingDir = app.isPackaged 
    ? path.join(process.resourcesPath, 'marketing-images')
    : path.join(__dirname, 'marketing-images');
  
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
        return 'file://' + filePath.replace(/\\/g, '/');
      });
    
    console.log('Found marketing images:', images.length);
    return images;
  } catch (err) {
    console.error('Error reading marketing images:', err.message);
    return [];
  }
}

function createCustomerDisplay() {
  const displays = screen.getAllDisplays();
  console.log('Available displays:', displays.length);
  
  let externalDisplay = displays.find(display => display.bounds.x !== 0 || display.bounds.y !== 0);
  
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
      contextIsolation: true
    }
  });

  const customerDisplayPath = path.join(process.env.SAL_STATIC_DIR || __dirname, 'customer-display.html');
  customerWindow.loadFile(customerDisplayPath);
  
  customerWindow.on('closed', () => {
    customerWindow = null;
  });
  
  customerWindow.webContents.on('did-finish-load', () => {
    const images = getMarketingImages();
    customerWindow.webContents.send('marketing-images', images);
  });
}

app.whenReady().then(async () => {
  setupPaths();
  
  try {
    const server = require('./server.js');
    await server.start();
    console.log('Server started successfully');
  } catch (err) {
    console.error('Failed to start server:', err);
  }
  
  const serverReady = await waitForServer('http://localhost:5000/api/products');
  if (serverReady) {
    console.log('Server is responding, creating window...');
    createWindow();
    setTimeout(() => {
      createCustomerDisplay();
    }, 1000);
  } else {
    console.error('Server failed to respond after multiple attempts');
    createWindow();
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

ipcMain.handle('print-receipt', async (event, payload) => {
  try {
    const { printReceipt } = require('./printer');
    const openDrawer = payload?.paymentType === 'Cash' || String(payload?.paymentType || '').includes('Cash');
    await new Promise(resolve => setTimeout(resolve, 300));
    await printReceipt(mainWindow, payload, openDrawer);
    return { ok: true };
  } catch (err) {
    console.error('Print error:', err.message);
    return { ok: false, error: err.message };
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
    const { getAvailablePrinters, printerName } = require('./printer');
    const printers = await getAvailablePrinters();
    return { ok: true, printers, currentPrinter: printerName };
  } catch (err) {
    console.error('Get printers error:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-for-updates', async () => {
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
