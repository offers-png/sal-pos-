const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

const {
  initDatabase,
  productRepo,
  salesRepo,
  returnsRepo,
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

const app = express();

app.use(express.json({ limit: '32mb' }));
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return res.status(403).end();
  if (req.headers.origin && req.headers.origin !== 'http://' + host) return res.status(403).json({ success: false, error: 'Cross-origin requests are not allowed' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
// Serialize API work, including reads and restore, across asynchronous repository calls.
let apiQueue = Promise.resolve();
app.use('/api', (req, res, next) => {
  const prior = apiQueue;
  apiQueue = new Promise(resolve => {
    res.once('finish', resolve);
    prior.then(() => { if (res.destroyed) resolve(); else { res.once('close', resolve); next(); } });
  });
});
const auth = require('./services/auth');
const transactions = require('./services/transactions');
auth.register(app);
const verifyManagerToken = auth.manager;
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/settings') {
    if ('tax_rate' in req.body && (!Number.isFinite(Number(req.body.tax_rate)) || Number(req.body.tax_rate) < 0 || Number(req.body.tax_rate) > 1)) return res.status(400).json({ success: false, error: 'Tax rate must be between 0 and 1' });
    if (Object.values(req.body).some(value => !['string','number','boolean'].includes(typeof value))) return res.status(400).json({ success: false, error: 'Invalid setting value' });
  }
  if (['POST','PUT'].includes(req.method) && (req.path === '/products' || (req.method === 'PUT' && req.path.startsWith('/products/')))) {
    const p = req.body;
    const invalid = typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200 || !Number.isFinite(p.price) || p.price < 0 || p.price > 1000000
      || (p.cost !== undefined && (!Number.isFinite(p.cost) || p.cost < 0))
      || ['stock','min_age','reorder_point'].some(field => p[field] !== undefined && (!Number.isSafeInteger(p[field]) || (field !== 'stock' && p[field] < 0)))
      || ['taxable','age_restricted','ebt_eligible'].some(field => p[field] !== undefined && typeof p[field] !== 'boolean');
    if (invalid) return res.status(400).json({ success: false, error: 'Invalid product fields' });
  }
  next();
});

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

const publicFiles = new Set(['index.html', 'login.html', 'products.html', 'settings.html', 'reports.html', 'customer-display.html', 'styles.css', 'icon.png', 'services/receiptService.js', 'services/eodReportsService.js', 'services/money.js', 'services/browser.js']);
app.get('/marketing-images/:name', (req, res) => {
  const name = req.params.name;
  if (name !== path.basename(name) || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return res.status(404).end();
  res.sendFile(path.join(process.env.SAL_MARKETING_DIR || path.join(path.dirname(dbPath), 'marketing-images'), name));
});
app.get('/vendor/purify.js', (req, res) => res.sendFile(require.resolve('dompurify/dist/purify.min.js')));
app.use((req, res, next) => {
  const file = req.path === '/' ? 'login.html' : req.path.slice(1);
  if (!publicFiles.has(file)) return next();
  if (file.endsWith('.html')) {
    const html = fs.readFileSync(path.join(staticDir, file), 'utf8');
    const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).map(m => "'sha256-" + require('crypto').createHash('sha256').update(m[1]).digest('base64') + "'");
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' " + hashes.join(' ') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return res.type('html').send(html);
  }
  res.sendFile(path.join(staticDir, file));
});

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

app.post("/api/products", async (req, res) => {
  const { barcode, name, price, cost, category, stock, taxable, age_restricted, min_age, ebt_eligible, reorder_point } = req.body || {};

  if (!barcode || !name || typeof price !== "number") {
    return res.status(400).json({ success: false, error: "Invalid product data" });
  }

  try {
    const existing = await productRepo.getByBarcode(barcode);
    const productData = { barcode, name, price, cost, category, stock, taxable, age_restricted, min_age, ebt_eligible, reorder_point };

    if (existing) {
      await productRepo.update(barcode, productData);
    } else {
      await productRepo.create(productData);
    }


    res.json({ success: true, message: existing ? "Product updated" : "Product created", saved_to: "sqlite" });
  } catch (err) {
    console.error("Error saving product:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/products/:barcode", async (req, res) => {
  const { barcode } = req.params;
  const { name, price, cost, category, stock, taxable, age_restricted, min_age, ebt_eligible, reorder_point } = req.body || {};

  if (!name || typeof price !== "number") {
    return res.status(400).json({ success: false, error: "Invalid product data" });
  }

  try {
    const existing = await productRepo.getByBarcode(barcode);
    if (!existing) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    const productData = { name, price, cost, category, stock, taxable, age_restricted, min_age, ebt_eligible, reorder_point };
    await productRepo.update(barcode, productData);

    res.json({ success: true, message: "Product updated", saved_to: "sqlite" });
  } catch (err) {
    console.error("Error updating product:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/products/low-stock", async (req, res) => {
  try {
    const products = await productRepo.getLowStock();
    res.json({ success: true, products });
  } catch (err) {
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
    res.json({ success: true, deleted_from: "sqlite" });
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

app.post('/api/sales', async (req, res) => {
  try {
    const result = await transactions.sale(req.body, req.user.id);
    res.json({ success: true, ...result, saved_to: 'sqlite' });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
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
    await transactions.voidSale(saleId, reason, req.user.id);
    res.json({ success: true, message: "Sale voided" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/:saleId', async (req, res) => {
  try { res.json({ success: true, sale: await transactions.lookup(req.params.saleId) }); }
  catch (error) { res.status(404).json({ success: false, error: error.message }); }
});
app.post('/api/sales/:saleId/return', async (req, res) => {
  try { res.json({ success: true, ...await transactions.refund(req.params.saleId, req.body, req.user.id) }); }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.get("/api/returns", async (req, res) => {
  try {
    const returns = await returnsRepo.getRecent(100);
    res.json({ success: true, returns });
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
      const methods = sale.tenders ? Object.keys(JSON.parse(sale.tenders)) : [sale.payment_type];
      for (const method of methods) if (counts[method] !== undefined) counts[method]++;

    }

    res.json({
      success: true,
      store: await settingsRepo.getAll(),
      totals,
      counts,
      grandTotal: summary.total_sales || 0,
      refundTotal: summary.refund_total,
      unallocatedTotal: summary.unallocated_total,
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
    const today = new Date().toLocaleDateString('en-CA');

    const sales = await salesRepo.getTodaySales();
    const counts = { Cash: 0, "Debit Card": 0, EBT: 0, "Store Credit": 0 };
    for (const sale of sales) {
      const methods = sale.tenders ? Object.keys(JSON.parse(sale.tenders)) : [sale.payment_type];
      for (const method of methods) if (counts[method] !== undefined) counts[method]++;

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
      refund_total: summary.refund_total,
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

async function authorizeUserChange(req, id, newRole) {
  const target = await userRepo.getById(Number(id));
  if (!target) throw Error('User not found');
  if ((target.role === 'owner' || newRole === 'owner') && req.user.role !== 'owner') throw Error('Only owners can change owner accounts');
  if (target.role === 'owner' && newRole && newRole !== 'owner') {
    const owners = (await userRepo.getAll()).filter(u => u.active && u.role === 'owner');
    if (owners.length <= 1) throw Error('Cannot remove the last owner');
  }
}

app.get("/api/users", async (req, res) => {
  try {
    const users = await userRepo.getAll();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/users", verifyManagerToken, async (req, res) => {
  const { username, pin, displayName, role } = req.body;
  if (!username || !auth.validPin(pin) || !['owner','manager','cashier'].includes(role)) {
    return res.status(400).json({ success: false, error: "Username and PIN required" });
  }

  try {
    if (role === 'owner' && req.user.role !== 'owner') throw Error('Only an owner can create another owner');
    const id = await userRepo.create({ username, pin, displayName, role });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/users/:id", verifyManagerToken, async (req, res) => {
  const { id } = req.params;
  const { displayName, role } = req.body;
  try {
    if (!['owner','manager','cashier'].includes(role)) throw Error('Invalid role');
    await authorizeUserChange(req, id, role);
    await userRepo.update(id, { displayName, role });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/users/:id/pin", verifyManagerToken, async (req, res) => {
  const { id } = req.params;
  const { newPin } = req.body;
  if (!auth.validPin(newPin)) {
    return res.status(400).json({ success: false, error: "PIN must contain 6-12 digits" });
  }
  try {
    await authorizeUserChange(req, id);
    await userRepo.updatePin(id, newPin);
    auth.clearSessions();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/users/:id", verifyManagerToken, async (req, res) => {
  const { id } = req.params;
  try {
    await authorizeUserChange(req, id, 'inactive');
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
      await settingsRepo.set(key, String(value));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/reports/daily/:date?", async (req, res) => {
  const date = req.params.date || new Date().toLocaleDateString('en-CA');
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

    const summary = transactions.summarize(await getDb(), 'shift_id = ?', [currentShift.id]);
    const totalSales = summary.total_sales, cashSales = summary.cash_total, cardSales = summary.card_total, ebtSales = summary.ebt_total, itemCount = summary.total_items;
    const sales = { length: summary.transaction_count };

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
        itemCount, refundTotal: summary.refund_total, unallocatedTotal: summary.unallocated_total
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
    let csv = "barcode,name,price,cost,category,stock,taxable,ebt_eligible,age_restricted,min_age,reorder_point\n";
    for (const p of products) {
      csv += [p.barcode, p.name, p.price, p.cost, p.category, p.stock, p.taxable ? 1 : 0, p.ebt_eligible ? 1 : 0, p.age_restricted ? 1 : 0, p.min_age, p.reorder_point ?? 5].map(require('./services/csv').cell).join(',') + '\n';
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

    const lines = require("./services/csv").parse(csvData);
    if (lines.length < 2) throw Error("CSV must contain a header and products");
    const headers = lines[0].map(h => h.toLowerCase().trim());
    if (!["barcode", "name", "price"].every(h => headers.includes(h))) throw Error("CSV requires barcode, name and price columns");

    let imported = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i];
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = (values[idx] || "").trim();
      });

      if (!row.name || !row.barcode || !row.price || !Number.isFinite(Number(row.price)) || Number(row.price) < 0) { skipped++; continue; }

      const product = {
        barcode: row.barcode || "",
        name: row.name,
        price: parseFloat(row.price) || 0,
        cost: parseFloat(row.cost) || 0,
        category: row.category || "General",
        stock: parseInt(row.stock) || 0,
        taxable: row.taxable === "1" || row.taxable === "true",
        ebt_eligible: row.ebt_eligible === "1" || row.ebt_eligible === "true",
        age_restricted: row.age_restricted === "1" || row.age_restricted === "true",
        min_age: parseInt(row.min_age) || 0,
        reorder_point: row.reorder_point !== undefined && row.reorder_point !== "" ? parseInt(row.reorder_point) : 5
      };

      if (![product.cost, product.price].every(v => Number.isFinite(v) && v >= 0 && v <= 1000000) || ![product.stock, product.min_age, product.reorder_point].every(Number.isSafeInteger) || product.min_age < 0 || product.reorder_point < 0) { skipped++; continue; }
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

    await require('./database').restoreDatabase(Buffer.from(dbBase64, 'base64'));
    auth.clearSessions();
    res.json({ success: true, message: 'Database restored. Sign in again.' });
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
    if (typeof backupPath !== "string" || !path.isAbsolute(backupPath) || !fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) return res.status(400).json({ success: false, error: "Choose an existing absolute folder path." });
    const db = await getDb();
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_backup_path', ?)", [backupPath]);
    db.run("DELETE FROM settings WHERE key = 'last_auto_backup_day'");
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

    const backupResult = await require('./services/backups').createBackup(backupFolder, 'manual-external');
    res.json({ success: true, ...backupResult });
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
      sales = await salesRepo.getByDateRange(startDate, endDate);
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
    const backupDir = path.join(path.dirname(dbPath), "backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }

    const result = await require('./services/backups').createBackup(backupDir);
    res.json({ success: true, ...result });
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
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(5000, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(listener); });
    listener.once('error', reject);
  });
  function scheduleBackup() {
    apiQueue = apiQueue.then(() => require('./services/backups').scheduledBackup()).catch(error => console.warn('Scheduled backup failed:', error.message));
  }
  scheduleBackup();
  const timer = setInterval(scheduleBackup, 60 * 60 * 1000); timer.unref();
  server.once('close', () => clearInterval(timer));
  console.log('Sal POS running on http://127.0.0.1:5000');
  return server;
}

app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, error: err.status === 413 ? 'Upload too large (32 MB limit)' : 'Request failed' }));

module.exports = { start, app };

if (require.main === module) {
  start().catch(error => { console.error(error); process.exitCode = 1; });
}
