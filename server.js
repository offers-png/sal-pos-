const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { google } = require("googleapis");

const { 
  initDatabase, 
  productRepo, 
  salesRepo, 
  userRepo, 
  shiftRepo, 
  settingsRepo,
  dailyReportsRepo,
  idChecksRepo,
  drawerLogRepo,
  getDb,
  saveDb,
  dbPath 
} = require("./database");

const PRODUCTS_SPREADSHEET_ID = process.env.PRODUCTS_SPREADSHEET_ID || "1y2TG1m9usaHE0uA6oOOiUYoj26n9jZRMXlQ9ASQ6Ptw";
const SALES_SPREADSHEET_ID = process.env.SALES_SPREADSHEET_ID || "1tzcyBK-wGnh8eFd8AZSA_xs1oMzCDg1NQgzfgFSvN5Q";
const PRODUCTS_SHEET = "Sheet1";
const SALES_SHEET = "Sheet1";

let sheetsApi = null;

async function initGoogleSheets() {
  try {
    let credentials = null;
    let credSource = null;
    
    // Method 1: Try environment variable JSON first (for Replit)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      console.log("Using Google credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON env var");
      credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      credSource = "env_json";
    } else {
      // Method 2: Try keyFile paths (for Windows POS)
      const possiblePaths = [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        
        path.join(process.env.SAL_RESOURCES_DIR || __dirname, "google-credentials.json"),
        path.join(__dirname, "google-credentials.json"),
        path.join(process.resourcesPath || __dirname, "google-credentials.json")
      ].filter(Boolean);
      
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          console.log("Using Google credentials from file:", p);
          credentials = JSON.parse(fs.readFileSync(p, "utf-8"));
          credSource = "file";
          break;
        }
      }
    }
    
    if (!credentials) {
      console.log("Google credentials not found - Sheets sync disabled");
      console.log("Place google-credentials.json in the app folder or set GOOGLE_APPLICATION_CREDENTIALS_JSON env var");
      return null;
    }
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    
    sheetsApi = google.sheets({ version: "v4", auth });
    console.log("Google Sheets API initialized successfully from:", credSource);
    return sheetsApi;
  } catch (err) {
    console.error("Failed to initialize Google Sheets:", err.message);
    console.error("Full error:", err);
    return null;
  }
}

async function syncProductToSheets(product) {
  if (!sheetsApi) return;
  try {
    const existingData = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: PRODUCTS_SPREADSHEET_ID,
      range: `${PRODUCTS_SHEET}!A:A`
    });
    
    const rows = existingData.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === product.barcode) {
        rowIndex = i + 1;
        break;
      }
    }
    
    const rowData = [
      product.barcode,
      product.name,
      product.price,
      product.category || ""
    ];
    
    if (rowIndex > 0) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: PRODUCTS_SPREADSHEET_ID,
        range: `${PRODUCTS_SHEET}!A${rowIndex}:D${rowIndex}`,
        valueInputOption: "RAW",
        resource: { values: [rowData] }
      });
      console.log(`Updated product in Sheets: ${product.barcode}`);
    } else {
      await sheetsApi.spreadsheets.values.append({
        spreadsheetId: PRODUCTS_SPREADSHEET_ID,
        range: `${PRODUCTS_SHEET}!A:D`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        resource: { values: [rowData] }
      });
      console.log(`Added product to Sheets: ${product.barcode}`);
    }
  } catch (err) {
    console.error("Error syncing product to Sheets:", err.message);
  }
}

async function syncSaleToSheets(sale) {
  if (!sheetsApi) {
    console.log("Sheets API not initialized - skipping sync");
    return;
  }
  try {
    console.log("Syncing sale to Sheets:", sale.saleId);
    const rowData = [
      sale.timestamp || new Date().toISOString(),
      sale.saleId,
      sale.paymentType,
      sale.subtotal,
      sale.discount || 0,
      sale.tax || 0,
      sale.total,
      sale.itemCount
    ];
    console.log("Row data:", rowData);
    
    const result = await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SALES_SPREADSHEET_ID,
      range: `${SALES_SHEET}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: { values: [rowData] }
    });
    console.log(`Added sale to Sheets: ${sale.saleId}`, result.data);
  } catch (err) {
    console.error("Error syncing sale to Sheets:", err.message);
    console.error("Full error:", err);
  }
}

async function deleteProductFromSheets(barcode) {
  if (!sheetsApi) return;
  try {
    // First get the spreadsheet ID (needed for batchUpdate)
    const existingData = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: PRODUCTS_SPREADSHEET_ID,
      range: `${PRODUCTS_SHEET}!A:A`
    });
    
    const rows = existingData.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === barcode) {
        rowIndex = i; // 0-based index
        break;
      }
    }

    if (rowIndex === -1) return;

    // Get the sheet ID for batchUpdate
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: PRODUCTS_SPREADSHEET_ID });
    const sheet = spreadsheet.data.sheets.find(s => s.properties.title === PRODUCTS_SHEET);
    const sheetId = sheet ? sheet.properties.sheetId : 0;

    // Delete the actual row so no blank rows are left behind
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: PRODUCTS_SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        }]
      }
    });
    console.log(`Deleted product row from Sheets: ${barcode}`);
  } catch (err) {
    console.error("Error deleting product from Sheets:", err.message);
  }
}

async function syncProductsFromSheets() {
  if (!sheetsApi) {
    return { success: false, error: "Google Sheets not connected" };
  }
  try {
    console.log("Starting sync from Google Sheets...");
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: PRODUCTS_SPREADSHEET_ID,
      range: `${PRODUCTS_SHEET}!A:D`
    });
    
    const rows = response.data.values || [];
    if (rows.length === 0) {
      return { success: true, synced: 0, message: "No products in Sheets" };
    }
    
    let synced = 0;
    let updated = 0;
    let skipped = 0;
    
    for (const row of rows) {
      const [barcode, name, price, category] = row;
      if (!barcode || !name) {
        skipped++;
        continue;
      }
      // Skip header row (e.g. "barcode","name","price","category")
      if (String(barcode).toLowerCase().trim() === 'barcode') {
        skipped++;
        continue;
      }
      
      const productData = {
        barcode: String(barcode).trim(),
        name: String(name).trim(),
        price: parseFloat(price) || 0,
        category: category || "Other / Misc"
      };
      
      try {
        const existing = await productRepo.getByBarcode(productData.barcode);
        if (existing) {
          await productRepo.update(productData.barcode, productData);
          updated++;
        } else {
          await productRepo.create(productData);
          synced++;
        }
      } catch (err) {
        console.error(`Error syncing product ${barcode}:`, err.message);
        skipped++;
      }
    }
    
    console.log(`Sync complete: ${synced} new, ${updated} updated, ${skipped} skipped`);
    return { success: true, synced, updated, skipped, total: rows.length };
  } catch (err) {
    console.error("Error syncing from Sheets:", err.message);
    return { success: false, error: err.message };
  }
}

initGoogleSheets();

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});

const staticDir = process.env.SAL_STATIC_DIR || __dirname;
const resourcesDir = process.env.SAL_RESOURCES_DIR || __dirname;
const isPackaged = process.env.SAL_IS_PACKAGED === 'true';

console.log('Server staticDir:', staticDir);
console.log('Server resourcesDir:', resourcesDir);
console.log('Server isPackaged:', isPackaged);

app.use(express.static(staticDir));

const productsFile = path.join(resourcesDir, "products.json");
const salesFile = path.join(resourcesDir, "sales.json");

function loadLocalProducts() {
  try {
    if (fs.existsSync(productsFile)) {
      const data = fs.readFileSync(productsFile, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error("Error reading products.json:", e.message);
  }
  return [];
}

function loadLocalSales() {
  try {
    if (fs.existsSync(salesFile)) {
      const data = fs.readFileSync(salesFile, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error("Error reading sales.json:", e.message);
  }
  return [];
}

app.get("/api/products", async (req, res) => {
  try {
    const products = await productRepo.getAll();
    res.json({ success: true, products, source: "sqlite" });
  } catch (err) {
    console.error("Error loading products:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/products/sync-from-sheets", async (req, res) => {
  try {
    const result = await syncProductsFromSheets();
    res.json(result);
  } catch (err) {
    console.error("Error syncing from Sheets:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/products", async (req, res) => {
  const { barcode, name, price, cost, category, stock, taxable, age_restricted, min_age } = req.body || {};
  
  if (!barcode || !name || typeof price !== "number") {
    return res.status(400).json({ success: false, error: "Invalid product data" });
  }

  try {
    const existing = await productRepo.getByBarcode(barcode);
    const productData = { barcode, name, price, cost, category, stock, taxable, age_restricted, min_age };
    
    if (existing) {
      await productRepo.update(barcode, productData);
    } else {
      await productRepo.create(productData);
    }
    
    syncProductToSheets(productData);
    
    res.json({ success: true, message: existing ? "Product updated" : "Product created", saved_to: "sqlite+sheets" });
  } catch (err) {
    console.error("Error saving product:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/products/:barcode", async (req, res) => {
  const { barcode } = req.params;
  if (!barcode) {
    return res.status(400).json({ success: false, error: "Missing barcode" });
  }

  try {
    await productRepo.delete(barcode);
    deleteProductFromSheets(barcode);
    res.json({ success: true, deleted_from: "sqlite+sheets" });
  } catch (err) {
    console.error("Error deleting product:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/products/categories", async (req, res) => {
  try {
    const categories = await productRepo.getCategories();
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/products/update-stock", async (req, res) => {
  const { barcode, quantity, reason, userId } = req.body;
  try {
    const newStock = await productRepo.updateStock(barcode, quantity, reason, userId);
    if (newStock === null) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    res.json({ success: true, newStock });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/sales", async (req, res) => {
  const { items, paymentType, subtotal, discount, tax, total, clientTimestamp, userId, shiftId } = req.body || {};
  const saleId = Date.now().toString();
  const itemCount = Array.isArray(items) ? items.reduce((sum, it) => sum + (it.qty || 1), 0) : 0;
  const timestamp = clientTimestamp || new Date().toISOString();
  const safePaymentType = paymentType || 'Cash';

  console.log("Sale request received:", { items: items?.length, paymentType: safePaymentType, subtotal, total, userId });

  try {
    const currentShift = await shiftRepo.getOpen();
    
    await salesRepo.create({
      saleId,
      items: items || [],
      subtotal: subtotal || 0,
      discount: discount || 0,
      tax: tax || 0,
      total: total || 0,
      paymentType: safePaymentType,
      itemCount,
      userId: userId !== undefined ? userId : null,
      shiftId: currentShift ? currentShift.id : null
    });

    for (const item of items || []) {
      if (item.barcode) {
        await productRepo.updateStock(item.barcode, -(item.qty || 1), 'sale', userId);
      }
    }

    syncSaleToSheets({
      timestamp,
      saleId,
      paymentType,
      subtotal: subtotal || 0,
      discount: discount || 0,
      tax: tax || 0,
      total: total || 0,
      itemCount,
      items
    });

    res.json({ success: true, saleId, saved_to: "sqlite+sheets" });
  } catch (err) {
    console.error("Error saving sale:", err);
    console.error("Error type:", typeof err);
    console.error("Error message:", err?.message);
    console.error("Error stack:", err?.stack);
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.get("/api/sales", async (req, res) => {
  try {
    const sales = await salesRepo.getAll(500);
    const formatted = sales.map(s => ({
      timestamp: s.created_at,
      saleId: s.sale_id,
      paymentType: s.payment_type,
      subtotal: s.subtotal,
      discount: s.discount,
      tax: s.tax,
      total: s.total,
      itemCount: s.item_count,
      voided: s.voided === 1
    }));
    res.json({ success: true, sales: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/sales/today", async (req, res) => {
  try {
    const sales = await salesRepo.getTodaySales();
    res.json({ success: true, sales });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/sales/:saleId/void", async (req, res) => {
  const { saleId } = req.params;
  const { reason, userId } = req.body;
  try {
    await salesRepo.voidSale(saleId, reason, userId);
    res.json({ success: true, message: "Sale voided" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/id-checks", async (req, res) => {
  try {
    const { check_type, dob, age, verified, min_age_required, user_id, shift_id, sale_id, notes } = req.body;
    await idChecksRepo.log({ check_type, dob, age, verified, min_age_required, user_id, shift_id, sale_id, notes });
    res.json({ success: true, message: "ID check logged" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/id-checks", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const checks = await idChecksRepo.getRecent(limit);
    res.json({ success: true, checks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/eod-today", async (req, res) => {
  try {
    const summary = await salesRepo.getDailySummary();
    const totals = {
      Cash: summary.cash_total || 0,
      "Debit Card": summary.card_total || 0,
      EBT: summary.ebt_total || 0,
      "Store Credit": summary.store_credit_total || 0
    };
    
    const sales = await salesRepo.getTodaySales();
    const counts = { Cash: 0, "Debit Card": 0, EBT: 0, "Store Credit": 0 };
    for (const sale of sales) {
      if (counts[sale.payment_type] !== undefined) {
        counts[sale.payment_type]++;
      }
    }

    res.json({
      success: true,
      totals,
      counts,
      grandTotal: summary.total_sales || 0,
      transactionCount: summary.transaction_count || 0,
      totalItems: summary.total_items || 0,
      totalDiscounts: summary.total_discounts || 0,
      totalTax: summary.total_tax || 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/daily-reports", async (req, res) => {
  try {
    const summary = await salesRepo.getDailySummary();
    const today = new Date().toISOString().split('T')[0];
    
    const sales = await salesRepo.getTodaySales();
    const counts = { Cash: 0, "Debit Card": 0, EBT: 0, "Store Credit": 0 };
    for (const sale of sales) {
      if (counts[sale.payment_type] !== undefined) {
        counts[sale.payment_type]++;
      }
    }
    
    const fullReportData = {
      ...summary,
      counts
    };
    
    const reportData = {
      report_date: today,
      total_sales: summary.total_sales || 0,
      cash_sales: summary.cash_total || 0,
      card_sales: summary.card_total || 0,
      ebt_sales: summary.ebt_total || 0,
      store_credit_sales: summary.store_credit_total || 0,
      tax_collected: summary.total_tax || 0,
      transaction_count: summary.transaction_count || 0,
      refund_total: 0,
      report_data: JSON.stringify(fullReportData),
      created_by: req.body.userId || null
    };
    
    await dailyReportsRepo.save(reportData);
    res.json({ success: true, message: "Daily report saved", report: reportData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/daily-reports", async (req, res) => {
  try {
    const reports = await dailyReportsRepo.getAll();
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/daily-reports/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const report = await dailyReportsRepo.getByDate(date);
    if (report) {
      res.json({ success: true, report });
    } else {
      res.json({ success: false, error: "No report found for this date" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/daily-reports-week", async (req, res) => {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 6);
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    const reports = await dailyReportsRepo.getDateRange(start, end);
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) {
    return res.status(400).json({ success: false, error: "Username and PIN required" });
  }

  try {
    const user = await userRepo.verifyPin(username, pin);
    if (user) {
      res.json({ success: true, user });
    } else {
      res.status(401).json({ success: false, error: "Invalid username or PIN" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Temporary access tokens for protected features (expires after 5 minutes)
const managerAccessTokens = new Map();

// Prune expired tokens every 10 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of managerAccessTokens.entries()) {
    if (data.expires < now) managerAccessTokens.delete(token);
  }
}, 10 * 60 * 1000);

// Verify manager/owner PIN for protected features
app.post("/api/auth/verify-manager-pin", async (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ success: false, error: "PIN required" });
  }

  try {
    // Get all users and check if PIN matches an owner or manager
    const users = await userRepo.getAll();
    for (const user of users) {
      if (user.role === 'owner' || user.role === 'manager') {
        const isValid = await userRepo.verifyPin(user.username, pin);
        if (isValid) {
          // Generate temporary access token (valid for 5 minutes)
          const token = Math.random().toString(36).substr(2) + Date.now().toString(36);
          managerAccessTokens.set(token, { role: user.role, expires: Date.now() + 5 * 60 * 1000 });
          return res.json({ success: true, authorized: true, role: user.role, accessToken: token });
        }
      }
    }
    res.json({ success: true, authorized: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Middleware to verify manager access token
function verifyManagerToken(req, res, next) {
  const token = req.headers['x-manager-token'];
  if (!token) {
    return res.status(401).json({ success: false, error: "Access token required" });
  }
  const tokenData = managerAccessTokens.get(token);
  if (!tokenData || tokenData.expires < Date.now()) {
    managerAccessTokens.delete(token);
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
  next();
}

app.get("/api/users", async (req, res) => {
  try {
    const users = await userRepo.getAll();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/users", async (req, res) => {
  const { username, pin, displayName, role } = req.body;
  if (!username || !pin) {
    return res.status(400).json({ success: false, error: "Username and PIN required" });
  }

  try {
    const id = await userRepo.create({ username, pin, displayName, role });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { displayName, role } = req.body;
  try {
    await userRepo.update(id, { displayName, role });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/users/:id/pin", async (req, res) => {
  const { id } = req.params;
  const { newPin } = req.body;
  if (!newPin || newPin.length < 4) {
    return res.status(400).json({ success: false, error: "PIN must be at least 4 digits" });
  }
  try {
    await userRepo.updatePin(id, newPin);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await userRepo.deactivate(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/shifts/current", async (req, res) => {
  try {
    const shift = await shiftRepo.getOpen();
    res.json({ success: true, shift: shift || null, isOpen: !!shift });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/shifts/open", async (req, res) => {
  const { userId, startingCash } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: "User ID required" });
  }

  try {
    const shiftId = await shiftRepo.open(userId, startingCash || 0);
    res.json({ success: true, shiftId });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/shifts/close", async (req, res) => {
  const { shiftId, userId, endingCash, notes = null } = req.body;
  if (!shiftId || !userId) {
    return res.status(400).json({ success: false, error: "Shift ID and User ID required" });
  }

  try {
    await shiftRepo.close(shiftId, userId, endingCash, notes);
    const closedShift = await shiftRepo.getById(shiftId);
    res.json({ success: true, shift: closedShift });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get("/api/shifts", async (req, res) => {
  try {
    const shifts = await shiftRepo.getRecent(20);
    res.json({ success: true, shifts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/shifts/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const shift = await shiftRepo.getById(id);
    if (!shift) {
      return res.status(404).json({ success: false, error: "Shift not found" });
    }
    const sales = await salesRepo.getShiftSales(id);
    res.json({ success: true, shift, sales });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const settings = await settingsRepo.getAll();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/settings", async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      await settingsRepo.set(key, value);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/reports/daily/:date?", async (req, res) => {
  const date = req.params.date || new Date().toISOString().slice(0, 10);
  try {
    const summary = await salesRepo.getDailySummary(date);
    res.json({ success: true, date, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/reports/x-report", async (req, res) => {
  try {
    const currentShift = await shiftRepo.getOpen();
    if (!currentShift) {
      return res.json({ success: true, message: "No shift open", data: null });
    }

    const sales = await salesRepo.getShiftSales(currentShift.id);
    let totalSales = 0, cashSales = 0, cardSales = 0, ebtSales = 0, itemCount = 0;
    
    for (const sale of sales) {
      totalSales += sale.total;
      itemCount += sale.item_count;
      if (sale.payment_type === 'Cash' || sale.payment_type === 'EBT + Cash') cashSales += sale.total;
      else if (sale.payment_type === 'Debit Card' || sale.payment_type === 'EBT + Debit Card') cardSales += sale.total;
      if (sale.payment_type === 'EBT' || String(sale.payment_type).startsWith('EBT +')) ebtSales += sale.total;
    }

    res.json({
      success: true,
      data: {
        shiftId: currentShift.id,
        openedAt: currentShift.opened_at,
        startingCash: currentShift.starting_cash,
        transactionCount: sales.length,
        totalSales,
        cashSales,
        cardSales,
        ebtSales,
        itemCount
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/reports/z-report/:shiftId", async (req, res) => {
  const { shiftId } = req.params;
  try {
    const shift = await shiftRepo.getById(shiftId);
    if (!shift) {
      return res.status(404).json({ success: false, error: "Shift not found" });
    }
    const sales = await salesRepo.getShiftSales(shiftId);
    res.json({ success: true, shift, sales });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export all products to CSV
app.get("/api/products/export/csv", async (req, res) => {
  try {
    const products = await productRepo.getAll();
    let csv = "barcode,name,price,cost,category,stock,taxable,ebt_eligible,age_restricted\n";
    for (const p of products) {
      csv += `"${p.barcode||""}","${p.name||""}",${p.price||0},${p.cost||0},"${p.category||""}",${p.stock||0},${p.taxable?1:0},${p.ebt_eligible?1:0},${p.age_restricted?1:0}\n`;
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="products-export-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Import products from CSV
app.post("/api/products/import/csv", async (req, res) => {
  try {
    const { csvData } = req.body;
    if (!csvData) return res.status(400).json({ success: false, error: "No CSV data provided" });
    
    const lines = csvData.split("\n").filter(l => l.trim());
    const headers = lines[0].toLowerCase().split(",").map(h => h.replace(/"/g, "").trim());
    
    let imported = 0;
    let skipped = 0;
    
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].match(/(".*?"|[^,]+)/g) || [];
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = (values[idx] || "").replace(/"/g, "").trim();
      });
      
      if (!row.name) { skipped++; continue; }
      
      const product = {
        barcode: row.barcode || "",
        name: row.name,
        price: parseFloat(row.price) || 0,
        cost: parseFloat(row.cost) || 0,
        category: row.category || "General",
        stock: parseInt(row.stock) || 0,
        taxable: row.taxable === "1" || row.taxable === "true",
        ebt_eligible: row.ebt_eligible === "1" || row.ebt_eligible === "true",
        age_restricted: row.age_restricted === "1" || row.age_restricted === "true"
      };
      
      await productRepo.upsert(product);
      imported++;
    }
    
    res.json({ success: true, imported, skipped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download the raw database file for full backup/restore
app.get("/api/backup/download", async (req, res) => {
  try {
    const date = new Date().toISOString().slice(0,10);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="sal-pos-full-backup-${date}.db"`);
    res.sendFile(dbPath);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restore database from uploaded .db file
app.post("/api/backup/restore", async (req, res) => {
  try {
    const { dbBase64 } = req.body;
    if (!dbBase64) return res.status(400).json({ success: false, error: "No database file provided" });
    
    // Save current db as emergency backup first
    const emergencyBackup = dbPath + ".emergency-" + Date.now();
    fs.copyFileSync(dbPath, emergencyBackup);
    
    // Write the restored database
    const dbBuffer = Buffer.from(dbBase64, "base64");
    fs.writeFileSync(dbPath, dbBuffer);
    
    res.json({ success: true, message: "Database restored. Please restart the app." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get/set auto-backup folder path
app.get("/api/settings/backup-path", async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec("SELECT value FROM settings WHERE key = 'auto_backup_path'");
    const backupPath = result.length && result[0].values.length ? result[0].values[0][0] : "";
    res.json({ success: true, path: backupPath });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/settings/backup-path", async (req, res) => {
  try {
    const { path: backupPath } = req.body;
    const db = await getDb();
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_backup_path', ?)", [backupPath]);
    saveDb();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Auto backup to custom path
app.post("/api/backup/auto", async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec("SELECT value FROM settings WHERE key = 'auto_backup_path'");
    const backupFolder = result.length && result[0].values.length ? result[0].values[0][0] : "";
    
    if (!backupFolder || !fs.existsSync(backupFolder)) {
      return res.status(400).json({ success: false, error: "Backup folder not set or not found. Please set a backup folder in Settings." });
    }
    
    const timestamp = new Date().toISOString().slice(0,10);
    const backupName = `sal-pos-backup-${timestamp}.db`;
    const backupPath = path.join(backupFolder, backupName);
    fs.copyFileSync(dbPath, backupPath);
    
    res.json({ success: true, path: backupPath, filename: backupName });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/reports/export/csv", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    let sales;
    if (startDate && endDate) {
      const inclusiveEnd = new Date(endDate);
      inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);
      const inclusiveEndStr = inclusiveEnd.toISOString().split('T')[0];
      sales = await salesRepo.getByDateRange(startDate, inclusiveEndStr);
    } else {
      sales = await salesRepo.getAll(10000);
    }

    let csv = "Date,Sale ID,Payment Type,Subtotal,Discount,Tax,Total,Items\n";
    for (const sale of sales) {
      csv += `"${sale.created_at}","${sale.sale_id}","${sale.payment_type}",${sale.subtotal},${sale.discount},${sale.tax},${sale.total},${sale.item_count}\n`;
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="sales-export-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/backup", async (req, res) => {
  try {
    const backupDir = path.join(__dirname, "backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `sal-pos-backup-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupName);

    fs.copyFileSync(dbPath, backupPath);

    const stats = fs.statSync(backupPath);
    
    const db = await getDb();
    db.run('INSERT INTO backups (filename, file_path, size_bytes, backup_type) VALUES (?, ?, ?, ?)',
      [backupName, backupPath, stats.size, "manual"]);
    saveDb();

    res.json({ success: true, filename: backupName, path: backupPath, size: stats.size });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/backups", async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec("SELECT * FROM backups ORDER BY created_at DESC");
    const backups = result.length ? result[0].values.map(row => {
      const cols = result[0].columns;
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return obj;
    }) : [];
    res.json({ success: true, backups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/migrate", async (req, res) => {
  try {
    let imported = 0;

    const localProducts = loadLocalProducts();
    if (localProducts.length > 0) {
      imported = await productRepo.importBulk(localProducts);
      console.log(`Migrated ${imported} products from local JSON`);
    }

    const localSales = loadLocalSales();
    if (localSales.length > 0) {
      for (const sale of localSales) {
        try {
          await salesRepo.create({
            saleId: sale.saleId || Date.now().toString(),
            items: sale.items || [],
            subtotal: sale.subtotal || 0,
            discount: sale.discount || 0,
            tax: sale.tax || 0,
            total: sale.total || 0,
            paymentType: sale.paymentType || 'Cash',
            itemCount: sale.itemCount || 0
          });
        } catch (e) {}
      }
      console.log(`Migrated ${localSales.length} sales from local JSON`);
    }

    res.json({ 
      success: true, 
      productsImported: imported,
      salesImported: localSales.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/drawer-log", async (req, res) => {
  try {
    const { reason, sale_amount, user_id, user_name, shift_id, sale_id } = req.body;
    await drawerLogRepo.log({ reason, sale_amount, user_id, user_name, shift_id, sale_id });
    res.json({ success: true });
  } catch (err) {
    console.error("Error logging drawer open:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/drawer-log", verifyManagerToken, async (req, res) => {
  try {
    const logs = await drawerLogRepo.getRecent(200);
    res.json({ success: true, logs });
  } catch (err) {
    console.error("Error getting drawer logs:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/drawer-log/today", verifyManagerToken, async (req, res) => {
  try {
    const logs = await drawerLogRepo.getTodayLogs();
    res.json({ success: true, logs });
  } catch (err) {
    console.error("Error getting today's drawer logs:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    const products = await productRepo.getAll();
    const currentShift = await shiftRepo.getOpen();
    const settings = await settingsRepo.getAll();

    res.json({
      success: true,
      database: "SQLite",
      databasePath: dbPath,
      productCount: products.length,
      shiftOpen: !!currentShift,
      currentShiftId: currentShift ? currentShift.id : null,
      settings
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

async function start() {
  await initDatabase();
  
  const products = await productRepo.getAll();
  if (products.length === 0) {
    const localProducts = loadLocalProducts();
    if (localProducts.length > 0) {
      await productRepo.importBulk(localProducts);
      console.log(`Auto-migrated ${localProducts.length} products from products.json`);
    }
  }

  const PORT = 5000;
  app.listen(PORT, "0.0.0.0", async () => {
    const allProducts = await productRepo.getAll();
    console.log(`Sal POS running on http://localhost:${PORT}`);
    console.log(`Database: SQLite (${dbPath})`);
    console.log(`Products loaded: ${allProducts.length}`);
    
    // Auto-sync products from Google Sheets on startup
    if (sheetsApi) {
      console.log("Auto-syncing products from Google Sheets...");
      try {
        const result = await syncProductsFromSheets();
        if (result.success) {
          console.log(`Sheets sync complete: ${result.synced} new, ${result.updated} updated, ${result.skipped} skipped`);
        } else {
          console.log("Sheets sync skipped:", result.error || "No connection");
        }
      } catch (err) {
        console.log("Sheets sync error (non-fatal):", err.message);
      }
    } else {
      console.log("Google Sheets not connected - skipping auto-sync");
    }
  });
}

module.exports = { start, app };

if (require.main === module) {
  start();
}
