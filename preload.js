const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  listMarketing: () => ipcRenderer.invoke('list-marketing'),
  addMarketing: () => ipcRenderer.invoke('add-marketing'),
  removeMarketing: name => ipcRenderer.invoke('remove-marketing', name),
  showCustomerScreen: () => ipcRenderer.invoke('show-customer-screen'),
  printReceipt: (data) => ipcRenderer.invoke('print-receipt', data),
  completeSale: (data) => ipcRenderer.invoke('complete-sale', data),
  openDrawer: () => ipcRenderer.invoke('open-drawer'),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  setPrinter: (printerName) => ipcRenderer.invoke('set-printer', printerName),
  testPrint: () => ipcRenderer.invoke('test-print'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  updateCustomerCart: (data) => ipcRenderer.invoke('update-customer-cart', data),
  onStoreBranding: callback => ipcRenderer.on('store-branding', (_, data) => callback(data)),
  onCartUpdate: (callback) => ipcRenderer.on('cart-update', (event, data) => callback(data)),
  onMarketingImages: (callback) => ipcRenderer.on('marketing-images', (event, images) => callback(images)),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (event, theme) => callback(theme)),
  requestCurrentTheme: () => ipcRenderer.invoke('request-current-theme'),
  syncTheme: (theme) => ipcRenderer.invoke('sync-theme', theme),
  onRestoreFocus: (callback) => ipcRenderer.on('restore-focus', () => callback())
});
