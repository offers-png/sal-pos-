const { BrowserWindow } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const printerName = process.env.SAL_PRINTER_NAME || "POS-80";

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

const CMD = {
  INIT: Buffer.from([ESC, 0x40]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  DOUBLE_SIZE: Buffer.from([GS, 0x21, 0x11]),
  NORMAL_SIZE: Buffer.from([GS, 0x21, 0x00]),
  CUT_PAPER: Buffer.from([GS, 0x56, 0x42, 0x00]),
  OPEN_DRAWER: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xFA]),
  LINE_FEED: Buffer.from([LF]),
  // ESC d n — feed n lines. More reliable than sending n x LF separately.
  FEED_6_LINES: Buffer.from([ESC, 0x64, 0x06])
};

let nativePrinter = null;
let nativePrinterAvailable = false;

try {
  nativePrinter = require('printer');
  nativePrinterAvailable = true;
  console.log('Native printer module loaded successfully');
} catch (e) {
  console.warn('Native printer module not available:', e.message);
  console.log('Will use Electron webContents.print() fallback');
}

function textToBuffer(text) {
  return Buffer.from(text, 'utf8');
}

function generateReceiptText(payload) {
  const {
    store, items, subtotal, discount,
    taxRate, taxAmount, total, paymentType, saleId,
    ebtAmount, nonEbtAmount, ebtDiscount, nonEbtTax, secondPaymentType
  } = payload || {};

  const isSplitEbt = !!secondPaymentType;

  const fmt = (n) => Number(n || 0).toFixed(2);
  const timestamp = new Date().toLocaleString();
  const width = 48;

  function center(text) {
    const pad = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(pad) + text;
  }

  function leftRight(left, right) {
    const maxLeft = width - 1 - right.length;
    if (left.length > maxLeft) {
      left = left.slice(0, maxLeft - 3) + '...';
    }
    const spaces = width - left.length - right.length;
    return left + ' '.repeat(spaces) + right;
  }

  const lines = [];

  lines.push(center(store?.name || 'My Store'));
  if (store?.phone) {
    lines.push(center(store.phone));
  }
  lines.push(center(timestamp));
  lines.push('-'.repeat(width));

  if (paymentType) {
    lines.push(center('Payment: ' + paymentType));
    lines.push('-'.repeat(width));
  }

  if (Array.isArray(items)) {
    if (isSplitEbt) {
      const ebtItems = items.filter(i => i.ebt_eligible);
      const nonEbtItems = items.filter(i => !i.ebt_eligible);

      if (ebtItems.length > 0) {
        lines.push(center('-- EBT (Tax Exempt) --'));
        ebtItems.forEach((item) => {
          const name = String(item.name || '').slice(0, 32);
          const qty = item.qty || 1;
          const price = fmt(item.price);
          const lineTotal = fmt(item.total || qty * (item.price || 0));
          lines.push(name);
          lines.push(leftRight(`  ${qty} x $${price}`, '$' + lineTotal));
        });
      }

      if (nonEbtItems.length > 0) {
        lines.push(center('-- Non-EBT (Taxable) --'));
        nonEbtItems.forEach((item) => {
          const name = String(item.name || '').slice(0, 32);
          const qty = item.qty || 1;
          const price = fmt(item.price);
          const lineTotal = fmt(item.total || qty * (item.price || 0));
          lines.push(name);
          lines.push(leftRight(`  ${qty} x $${price}`, '$' + lineTotal));
        });
      }
    } else {
      items.forEach((item) => {
        const name = String(item.name || '').slice(0, 32);
        const qty = item.qty || 1;
        const price = fmt(item.price);
        const lineTotal = fmt(item.total || qty * (item.price || 0));
        lines.push(name);
        lines.push(leftRight(`  ${qty} x $${price}`, '$' + lineTotal));
      });
    }
  }

  lines.push('-'.repeat(width));
  lines.push(leftRight('Subtotal:', '$' + fmt(subtotal)));

  if (discount) {
    lines.push(leftRight('Discount:', '-$' + fmt(discount)));
  }

  if (isSplitEbt) {
    if (nonEbtTax) {
      lines.push(leftRight('Tax (non-EBT only):', '$' + fmt(nonEbtTax)));
    }
  } else {
    if (taxAmount) {
      lines.push(leftRight(`Tax (${taxRate || 0}%):`, '$' + fmt(taxAmount)));
    }
  }

  lines.push('='.repeat(width));
  lines.push(leftRight('TOTAL:', '$' + fmt(total)));

  if (isSplitEbt) {
    lines.push('-'.repeat(width));
    lines.push('SPLIT PAYMENT:');
    const ebtLabel = ebtDiscount > 0 ? 'EBT (Food, after disc.)' : 'EBT (Food)';
    lines.push(leftRight(ebtLabel, '$' + fmt(ebtAmount)));
    lines.push(leftRight(secondPaymentType + ' (incl. tax):', '$' + fmt(nonEbtAmount)));
  }

  lines.push('');
  lines.push(center('Thank you for shopping!'));

  if (saleId) {
    lines.push(center('Receipt: ' + saleId));
  }

  // Extra blank lines to push content fully past the print head before cutting
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

function printReceiptRaw(payload, includeCut = true, includeDrawer = true) {
  return new Promise((resolve, reject) => {
    if (!nativePrinterAvailable) {
      return reject(new Error('Native printer module not available'));
    }

    const receiptText = generateReceiptText(payload);
    console.log('Printing receipt to:', printerName);

    const buffers = [
      CMD.INIT,
      textToBuffer(receiptText)
    ];

    if (includeDrawer) {
      buffers.push(CMD.OPEN_DRAWER);
    }

    if (includeCut) {
      // ESC d 6 — advance 6 lines past print head before cutting.
      // Prevents last lines being eaten by the cutter.
      buffers.push(CMD.FEED_6_LINES);
      buffers.push(CMD.CUT_PAPER);
    }

    const finalBuffer = Buffer.concat(buffers);

    nativePrinter.printDirect({
      data: finalBuffer,
      type: 'RAW',
      printer: printerName,
      success: (jobId) => {
        console.log('Receipt printed successfully, Job ID:', jobId);
        resolve();
      },
      error: (err) => {
        console.error('Print error:', err);
        reject(new Error(typeof err === 'string' ? err : err.message || 'Print failed'));
      }
    });
  });
}

function openCashDrawerWindows() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      console.warn('Windows drawer fallback only works on Windows');
      return resolve();
    }

    try {
      const tempDir = os.tmpdir();
      const dataFile = path.join(tempDir, 'drawer_cmd.bin');
      const scriptFile = path.join(tempDir, 'open_drawer.ps1');
      const drawerCommand = Buffer.concat([CMD.INIT, CMD.OPEN_DRAWER]);
      fs.writeFileSync(dataFile, drawerCommand);
      
      const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int Level, ref DOCINFOA pDocInfo);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DOCINFOA { public string pDocName; public string pOutputFile; public string pDatatype; }
    public static bool SendRaw(string printerName, byte[] data) {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
        var di = new DOCINFOA { pDocName = "RAW", pOutputFile = null, pDatatype = "RAW" };
        if (!StartDocPrinter(hPrinter, 1, ref di)) { ClosePrinter(hPrinter); return false; }
        StartPagePrinter(hPrinter);
        int written;
        WritePrinter(hPrinter, data, data.Length, out written);
        EndPagePrinter(hPrinter);
        EndDocPrinter(hPrinter);
        ClosePrinter(hPrinter);
        return true;
    }
}
'@
$bytes = [System.IO.File]::ReadAllBytes('${dataFile.replace(/\\/g, '\\\\')}')
[RawPrinter]::SendRaw('${printerName}', $bytes)
`;
      fs.writeFileSync(scriptFile, psScript, 'utf8');
      
      console.log('Opening drawer via PowerShell Win32 API');
      
      try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`, 
          { windowsHide: true, timeout: 15000 });
        console.log('Cash drawer opened via PowerShell Win32 API');
      } catch (cmdErr) {
        console.warn('PowerShell drawer command failed:', cmdErr.message);
      }
      
      try { fs.unlinkSync(dataFile); } catch (e) {}
      try { fs.unlinkSync(scriptFile); } catch (e) {}
      resolve();
    } catch (err) {
      console.error('Windows drawer fallback error:', err);
      resolve();
    }
  });
}

function openCashDrawerRaw() {
  return new Promise((resolve, reject) => {
    if (!nativePrinterAvailable) {
      console.warn('Native printer not available - trying Windows fallback');
      return openCashDrawerWindows().then(resolve);
    }

    console.log('Opening cash drawer via raw ESC/POS command');

    const drawerCommand = Buffer.concat([CMD.INIT, CMD.OPEN_DRAWER]);

    nativePrinter.printDirect({
      data: drawerCommand,
      type: 'RAW',
      printer: printerName,
      success: (jobId) => {
        console.log('Cash drawer opened, Job ID:', jobId);
        resolve();
      },
      error: (err) => {
        console.error('Cash drawer error:', err);
        openCashDrawerWindows().then(resolve);
      }
    });
  });
}

function generateReceiptHTML(payload) {
  const {
    store, items, subtotal, discount,
    taxRate, taxAmount, total, paymentType, saleId,
    ebtAmount, nonEbtAmount, ebtDiscount, nonEbtTax, secondPaymentType
  } = payload || {};

  const fmt = (n) => Number(n || 0).toFixed(2);
  const timestamp = new Date().toLocaleString();
  const isSplitEbt = !!secondPaymentType;

  let itemsHTML = '';
  if (Array.isArray(items)) {
    if (isSplitEbt) {
      const ebtItems = items.filter(i => i.ebt_eligible);
      const nonEbtItems = items.filter(i => !i.ebt_eligible);
      if (ebtItems.length > 0) {
        itemsHTML += `<div class="section-label ebt-label">-- EBT (Tax Exempt) --</div>`;
        ebtItems.forEach((item) => {
          const name = String(item.name || '').slice(0, 24);
          const qty = item.qty || 1;
          itemsHTML += `
            <div class="item">
              <span class="item-name">${name}</span>
              <span class="item-details">${qty} x $${fmt(item.price)}</span>
              <span class="item-total">$${fmt(item.total || qty * (item.price || 0))}</span>
            </div>`;
        });
      }
      if (nonEbtItems.length > 0) {
        itemsHTML += `<div class="section-label nonebt-label">-- Non-EBT (Taxable) --</div>`;
        nonEbtItems.forEach((item) => {
          const name = String(item.name || '').slice(0, 24);
          const qty = item.qty || 1;
          itemsHTML += `
            <div class="item">
              <span class="item-name">${name}</span>
              <span class="item-details">${qty} x $${fmt(item.price)}</span>
              <span class="item-total">$${fmt(item.total || qty * (item.price || 0))}</span>
            </div>`;
        });
      }
    } else {
      items.forEach((item) => {
        const name = String(item.name || '').slice(0, 24);
        const qty = item.qty || 1;
        itemsHTML += `
          <div class="item">
            <span class="item-name">${name}</span>
            <span class="item-details">${qty} x $${fmt(item.price)}</span>
            <span class="item-total">$${fmt(item.total || qty * (item.price || 0))}</span>
          </div>`;
      });
    }
  }

  const splitTotalsHTML = isSplitEbt ? `
    <div class="divider"></div>
    <div style="font-weight:bold;margin-bottom:3px;">SPLIT PAYMENT:</div>
    <div class="total-line"><span>${ebtDiscount > 0 ? 'EBT (after disc.)' : 'EBT (Food)'}:</span><span>$${fmt(ebtAmount)}</span></div>
    <div class="total-line"><span>${secondPaymentType} (incl. tax):</span><span>$${fmt(nonEbtAmount)}</span></div>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @media print {
      @page { size: 72mm auto; margin: 0; }
      body { margin: 0; padding: 0; }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      width: 72mm;
      padding: 3mm;
      background: white;
      color: black;
    }
    .header { text-align: center; margin-bottom: 8px; }
    .store-name { font-size: 14px; font-weight: bold; }
    .store-phone { font-size: 10px; }
    .divider { border-top: 1px dashed black; margin: 6px 0; }
    .payment-type { text-align: center; font-weight: bold; margin-bottom: 4px; }
    .section-label { text-align: center; font-size: 10px; font-weight: bold; margin: 4px 0; }
    .ebt-label { color: #006400; }
    .nonebt-label { color: #8B4500; }
    .item { display: flex; flex-wrap: wrap; margin-bottom: 3px; }
    .item-name { width: 100%; font-weight: 500; }
    .item-details { flex: 1; font-size: 10px; }
    .item-total { text-align: right; }
    .totals { margin-top: 6px; }
    .total-line { display: flex; justify-content: space-between; margin-bottom: 2px; }
    .grand-total { font-size: 13px; font-weight: bold; border-top: 1px solid black; padding-top: 4px; margin-top: 4px; }
    .footer { text-align: center; margin-top: 10px; font-size: 10px; }
    .sale-id { font-size: 9px; color: #666; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="store-name">${store?.name || 'My Store'}</div>
    ${store?.phone ? `<div class="store-phone">${store.phone}</div>` : ''}
    <div class="store-phone">${timestamp}</div>
  </div>
  <div class="divider"></div>
  ${paymentType ? `<div class="payment-type">Payment: ${paymentType}</div><div class="divider"></div>` : ''}
  <div class="items">${itemsHTML}</div>
  <div class="divider"></div>
  <div class="totals">
    <div class="total-line"><span>Subtotal:</span><span>$${fmt(subtotal)}</span></div>
    ${discount ? `<div class="total-line"><span>Discount:</span><span>-$${fmt(discount)}</span></div>` : ''}
    ${isSplitEbt
      ? (nonEbtTax ? `<div class="total-line"><span>Tax (non-EBT only):</span><span>$${fmt(nonEbtTax)}</span></div>` : '')
      : (taxAmount ? `<div class="total-line"><span>Tax (${taxRate || 0}%):</span><span>$${fmt(taxAmount)}</span></div>` : '')
    }
    <div class="total-line grand-total"><span>TOTAL:</span><span>$${fmt(total)}</span></div>
  </div>
  ${splitTotalsHTML}
  <div class="footer">
    Thank you for shopping!
    ${saleId ? `<div class="sale-id">Receipt: ${saleId}</div>` : ''}
  </div>
</body>
</html>
  `;
}

function printReceiptWindows(mainWindow, payload) {
  return new Promise((resolve, reject) => {
    console.log(`Printing receipt via Windows driver to: ${printerName}`);

    const receiptWindow = new BrowserWindow({
      show: false,
      width: 280,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const html = generateReceiptHTML(payload);
    receiptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    receiptWindow.webContents.on('did-finish-load', () => {
      const options = {
        silent: true,
        deviceName: printerName,
        printBackground: true
      };

      receiptWindow.webContents.print(options, (success, error) => {
        receiptWindow.close();
        if (!success) {
          console.log("PRINT ERROR:", error);
          reject(new Error(error || 'Print failed'));
        } else {
          console.log('Receipt printed successfully via Windows driver');
          resolve();
        }
      });
    });

    receiptWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      receiptWindow.close();
      reject(new Error(`Failed to load receipt: ${errorDescription}`));
    });
  });
}

let isPrinting = false;

async function printReceipt(mainWindow, payload, openDrawer = true) {
  // Prevent concurrent/double prints
  if (isPrinting) {
    console.warn('Print already in progress — ignoring duplicate request');
    throw new Error('Print already in progress. Please wait.');
  }

  isPrinting = true;
  try {
    // Check if this is a custom HTML print (like EOD report)
    if (payload && payload.html) {
      await printCustomHTML(mainWindow, payload.html);
      return;
    }

    if (nativePrinterAvailable) {
      // Use ESC/POS only — no Windows fallback to prevent double printing
      await printReceiptRaw(payload, true, openDrawer);
      return;
    }

    // ESC/POS native module not available — use Windows driver
    await printReceiptWindows(mainWindow, payload);

    if (openDrawer) {
      try {
        await openCashDrawerRaw();
      } catch (err) {
        console.warn('Failed to open drawer after Windows print:', err.message);
      }
    }
  } finally {
    isPrinting = false;
  }
}

function printCustomHTML(mainWindow, htmlContent) {
  return new Promise((resolve, reject) => {
    console.log(`Printing custom HTML to: ${printerName}`);

    const printWindow = new BrowserWindow({
      show: false,
      width: 400,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

    printWindow.webContents.on('did-finish-load', () => {
      const options = {
        silent: true,
        deviceName: printerName,
        printBackground: true
      };

      printWindow.webContents.print(options, (success, error) => {
        printWindow.close();
        if (!success) {
          console.log("PRINT ERROR:", error);
          reject(new Error(error || 'Print failed'));
        } else {
          console.log('Custom HTML printed successfully');
          resolve();
        }
      });
    });

    printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      printWindow.close();
      reject(new Error(`Failed to load HTML: ${errorDescription}`));
    });
  });
}

async function openCashDrawer() {
  await openCashDrawerRaw();
}

function getAvailablePrinters() {
  return new Promise((resolve) => {
    if (nativePrinterAvailable) {
      try {
        const printers = nativePrinter.getPrinters();
        resolve(printers.map(p => ({ name: p.name, isDefault: p.isDefault })));
        return;
      } catch (err) {
        console.warn('Failed to get printers via native module:', err.message);
      }
    }

    const tempWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    tempWindow.webContents.getPrintersAsync().then((printers) => {
      tempWindow.close();
      resolve(printers);
    }).catch((err) => {
      tempWindow.close();
      console.error('Failed to get printers:', err);
      resolve([]);
    });
  });
}

module.exports = { 
  printReceipt, 
  openCashDrawer,
  getAvailablePrinters,
  printerName,
  nativePrinterAvailable,
  CMD
};
