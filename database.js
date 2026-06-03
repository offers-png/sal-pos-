const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Helper to format local date boundaries as SQL-compatible UTC strings
// SQLite CURRENT_TIMESTAMP uses 'YYYY-MM-DD HH:MM:SS' format (no T, no Z)
function formatLocalDayBoundsForSql(date) {
  let startOfDay, endOfDay;
  if (date) {
    // If date provided as YYYY-MM-DD string, parse it as local date
    const [year, month, day] = date.split('-').map(Number);
    startOfDay = new Date(year, month - 1, day, 0, 0, 0);
    endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
  } else {
    // Default to today in local time
    const now = new Date();
    startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  }
  // Convert to UTC ISO string, then format for SQLite (replace T with space, remove Z and milliseconds)
  const formatForSql = (d) => d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
  return {
    startSql: formatForSql(startOfDay),
    endSql: formatForSql(endOfDay)
  };
}

const dbPath = process.env.SAL_DB_PATH || path.join(__dirname, 'sal-pos.db');
let db = null;
let SQL = null;

function isDbAlive(handle) {
  // sql.js stores DB in WASM memory. After system sleep Windows can page out
  // the Node process — db is non-null but WASM heap is gone, so every query throws.
  // Run a trivial probe to confirm the handle is actually usable.
  try {
    handle.exec('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}

async function getDb() {
  if (db && !isDbAlive(db)) {
    // Dead handle after sleep — force full re-init from disk
    console.warn('[db] Database handle dead after sleep, reinitializing...');
    db = null;
  }

  if (!db) {
    if (!SQL) {
      const sqljsDir = process.env.SAL_SQLJS_DIR || path.join(__dirname, 'node_modules', 'sql.js', 'dist');
      SQL = await initSqlJs({
        locateFile: file => path.join(sqljsDir, file)
      });
    }

    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    console.log('[db] Database reinitialized from disk');
  }
  return db;
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

async function initDatabase() {
  const db = await getDb();
  
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      cost REAL DEFAULT 0,
      category TEXT DEFAULT 'Other / Misc',
      stock INTEGER DEFAULT 0,
      taxable INTEGER DEFAULT 1,
      age_restricted INTEGER DEFAULT 0,
      min_age INTEGER DEFAULT 0,
      ebt_eligible INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const productsTableInfo = db.exec("PRAGMA table_info(products)");
  if (productsTableInfo.length > 0) {
    const columns = productsTableInfo[0].values.map(row => row[1]);
    if (!columns.includes('ebt_eligible')) {
      try { db.run(`ALTER TABLE products ADD COLUMN ebt_eligible INTEGER DEFAULT 0`); } catch(e) {}
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id TEXT UNIQUE NOT NULL,
      items TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL DEFAULT 0,
      tax REAL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_type TEXT NOT NULL,
      item_count INTEGER DEFAULT 0,
      user_id INTEGER,
      shift_id INTEGER,
      voided INTEGER DEFAULT 0,
      void_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pin TEXT NOT NULL,
      password TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'cashier',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opened_by INTEGER NOT NULL,
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_by INTEGER,
      closed_at TEXT,
      starting_cash REAL DEFAULT 0,
      ending_cash REAL,
      total_sales REAL DEFAULT 0,
      total_transactions INTEGER DEFAULT 0,
      cash_sales REAL DEFAULT 0,
      card_sales REAL DEFAULT 0,
      ebt_sales REAL DEFAULT 0,
      notes TEXT,
      status TEXT DEFAULT 'open'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      previous_stock INTEGER,
      new_stock INTEGER,
      reason TEXT,
      user_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER,
      backup_type TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL UNIQUE,
      total_sales REAL DEFAULT 0,
      cash_sales REAL DEFAULT 0,
      card_sales REAL DEFAULT 0,
      ebt_sales REAL DEFAULT 0,
      store_credit_sales REAL DEFAULT 0,
      tax_collected REAL DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,
      refund_total REAL DEFAULT 0,
      report_data TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS id_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_type TEXT NOT NULL,
      dob TEXT,
      age INTEGER,
      verified INTEGER DEFAULT 0,
      min_age_required INTEGER DEFAULT 21,
      user_id INTEGER,
      shift_id INTEGER,
      sale_id TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS drawer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      sale_amount REAL DEFAULT 0,
      user_id INTEGER,
      user_name TEXT,
      shift_id INTEGER,
      sale_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  const tableInfo = db.exec("PRAGMA table_info(daily_reports)");
  if (tableInfo.length > 0) {
    const columns = tableInfo[0].values.map(row => row[1]);
    if (!columns.includes('store_credit_sales')) {
      try { db.run(`ALTER TABLE daily_reports ADD COLUMN store_credit_sales REAL DEFAULT 0`); } catch(e) {}
    }
  }

  try { db.run(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status)`); } catch(e) {}

  await initDefaultSettings();
  await initDefaultUser();
  
  saveDb();
  console.log('SQLite database initialized successfully');
  return db;
}

async function initDefaultSettings() {
  const db = await getDb();
  const defaults = [
    { key: 'store_name', value: 'My Store' },
    { key: 'tax_rate', value: '0.0825' },
    { key: 'receipt_header', value: 'Welcome to My Store!' },
    { key: 'receipt_footer', value: 'Thank you for shopping with us!' },
    { key: 'theme', value: 'light' },
    { key: 'printer_enabled', value: 'true' },
    { key: 'cash_drawer_enabled', value: 'true' },
    { key: 'auto_backup', value: 'true' },
    { key: 'backup_time', value: '23:00' },
  ];

  for (const setting of defaults) {
    try {
      db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [setting.key, setting.value]);
    } catch(e) {}
  }
}

async function initDefaultUser() {
  const db = await getDb();
  const result = db.exec("SELECT id FROM users WHERE role = 'owner'");
  
  if (!result.length || !result[0].values.length) {
    const hashedPin = bcrypt.hashSync('1234', 10);
    db.run('INSERT INTO users (username, pin, display_name, role) VALUES (?, ?, ?, ?)',
      ['owner', hashedPin, 'Store Owner', 'owner']);
    console.log('Default owner user created (PIN: 1234)');
  }
}

const productRepo = {
  async getAll() {
    const db = await getDb();
    const result = db.exec('SELECT * FROM products WHERE active = 1 ORDER BY name');
    return result.length ? result[0].values.map(row => rowToProduct(result[0].columns, row)) : [];
  },

  async getByBarcode(barcode) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM products WHERE barcode = ? AND active = 1');
    stmt.bind([barcode]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  async getById(id) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  async create(product) {
    const db = await getDb();
    db.run(`
      INSERT INTO products (barcode, name, price, cost, category, stock, taxable, age_restricted, min_age)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      product.barcode,
      product.name,
      product.price || 0,
      product.cost || 0,
      product.category || 'Other / Misc',
      product.stock || 0,
      product.taxable !== false ? 1 : 0,
      product.age_restricted ? 1 : 0,
      product.min_age || 0
    ]);
    saveDb();
    return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  },

  async update(barcode, product) {
    const db = await getDb();
    db.run(`
      UPDATE products 
      SET name = ?, price = ?, cost = ?, category = ?, stock = ?, 
          taxable = ?, age_restricted = ?, min_age = ?, updated_at = CURRENT_TIMESTAMP
      WHERE barcode = ?
    `, [
      product.name,
      product.price || 0,
      product.cost || 0,
      product.category || 'Other / Misc',
      product.stock || 0,
      product.taxable !== false ? 1 : 0,
      product.age_restricted ? 1 : 0,
      product.min_age || 0,
      barcode
    ]);
    saveDb();
  },

  async delete(barcode) {
    const db = await getDb();
    db.run('UPDATE products SET active = 0 WHERE barcode = ?', [barcode]);
    saveDb();
  },

  async updateStock(barcode, quantityChange, reason, userId) {
    const product = await this.getByBarcode(barcode);
    if (!product) return null;

    const newStock = (product.stock || 0) + quantityChange;
    const db = await getDb();
    db.run('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE barcode = ?', [newStock, String(barcode)]);
    
    // Ensure all params have proper types - sql.js is strict
    const safeUserId = (userId != null && !isNaN(Number(userId))) ? Number(userId) : 0;
    const safeReason = String(reason || 'adjustment');
    
    db.run(`
      INSERT INTO inventory_log (product_id, change_type, quantity_change, previous_stock, new_stock, reason, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [Number(product.id), quantityChange > 0 ? 'add' : 'subtract', Number(quantityChange), Number(product.stock || 0), Number(newStock), safeReason, safeUserId]);
    
    saveDb();
    return newStock;
  },

  async getCategories() {
    const db = await getDb();
    const result = db.exec('SELECT DISTINCT category FROM products WHERE active = 1 ORDER BY category');
    return result.length ? result[0].values.map(r => r[0]) : [];
  },

  async importBulk(products) {
    const db = await getDb();
    for (const p of products) {
      try {
        db.run(`
          INSERT OR REPLACE INTO products (barcode, name, price, cost, category, stock, taxable, age_restricted, min_age)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          p.barcode,
          p.name,
          p.price || 0,
          p.cost || 0,
          p.category || 'Other / Misc',
          p.stock || 0,
          p.taxable !== false ? 1 : 0,
          p.age_restricted ? 1 : 0,
          p.min_age || 0
        ]);
      } catch(e) {}
    }
    saveDb();
    return products.length;
  }
};

const salesRepo = {
  async create(sale) {
    const db = await getDb();
    // Handle all params carefully - sql.js is strict about types
    const saleId = String(sale.saleId || Date.now().toString());
    const items = JSON.stringify(sale.items || []);
    const subtotal = Number(sale.subtotal) || 0;
    const discount = Number(sale.discount) || 0;
    const tax = Number(sale.tax) || 0;
    const total = Number(sale.total) || 0;
    const paymentType = String(sale.paymentType || 'Cash');
    const itemCount = Number(sale.itemCount) || 0;
    // Use 0 instead of null for user_id and shift_id since sql.js has issues with null
    const userId = (sale.userId != null && !isNaN(Number(sale.userId))) ? Number(sale.userId) : 0;
    const shiftId = (sale.shiftId != null && !isNaN(Number(sale.shiftId))) ? Number(sale.shiftId) : 0;
    
    const params = [saleId, items, subtotal, discount, tax, total, paymentType, itemCount, userId, shiftId];
    console.log("Creating sale with params:", params);
    db.run(`
      INSERT INTO sales (sale_id, items, subtotal, discount, tax, total, payment_type, item_count, user_id, shift_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, params);
    saveDb();
    return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  },

  async getById(saleId) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM sales WHERE sale_id = ?');
    stmt.bind([saleId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  async getAll(limit = 100, offset = 0) {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM sales ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`);
    return result.length ? result[0].values.map(row => rowToSale(result[0].columns, row)) : [];
  },

  async getByDateRange(startDate, endDate) {
    // Use local day boundaries so date ranges align with local time, not UTC
    const { startSql } = formatLocalDayBoundsForSql(startDate);
    const { endSql } = formatLocalDayBoundsForSql(endDate);
    const db = await getDb();
    const result = db.exec(`
      SELECT * FROM sales 
      WHERE created_at >= '${startSql}' AND created_at <= '${endSql}' 
      ORDER BY created_at DESC
    `);
    return result.length ? result[0].values.map(row => rowToSale(result[0].columns, row)) : [];
  },

  async getTodaySales() {
    // Use local time boundaries formatted for SQLite comparison
    const { startSql, endSql } = formatLocalDayBoundsForSql();
    
    const db = await getDb();
    const result = db.exec(`
      SELECT * FROM sales 
      WHERE created_at >= '${startSql}' AND created_at <= '${endSql}' AND voided = 0
      ORDER BY created_at DESC
    `);
    return result.length ? result[0].values.map(row => rowToSale(result[0].columns, row)) : [];
  },

  async getShiftSales(shiftId) {
    const db = await getDb();
    const result = db.exec('SELECT * FROM sales WHERE shift_id = ? AND voided = 0', [Number(shiftId)]);
    return result.length ? result[0].values.map(row => rowToSale(result[0].columns, row)) : [];
  },

  async voidSale(saleId, reason, userId) {
    const db = await getDb();
    db.run('UPDATE sales SET voided = 1, void_reason = ? WHERE sale_id = ?', [reason, saleId]);
    saveDb();
  },

  async getDailySummary(date) {
    // Use local time boundaries formatted for SQLite comparison
    const { startSql, endSql } = formatLocalDayBoundsForSql(date);
    
    const db = await getDb();
    const result = db.exec(`
      SELECT 
        COUNT(*) as transaction_count,
        COALESCE(SUM(total), 0) as total_sales,
        COALESCE(SUM(CASE WHEN payment_type = 'Cash' OR payment_type = 'EBT + Cash' THEN total ELSE 0 END), 0) as cash_total,
        COALESCE(SUM(CASE WHEN payment_type = 'Debit Card' OR payment_type = 'EBT + Debit Card' THEN total ELSE 0 END), 0) as card_total,
        COALESCE(SUM(CASE WHEN payment_type = 'EBT' OR payment_type LIKE 'EBT +%' THEN total ELSE 0 END), 0) as ebt_total,
        COALESCE(SUM(CASE WHEN payment_type = 'Store Credit' THEN total ELSE 0 END), 0) as store_credit_total,
        COALESCE(SUM(item_count), 0) as total_items,
        COALESCE(SUM(discount), 0) as total_discounts,
        COALESCE(SUM(tax), 0) as total_tax
      FROM sales 
      WHERE created_at >= '${startSql}' AND created_at <= '${endSql}' AND voided = 0
    `);
    if (result.length && result[0].values.length) {
      const cols = result[0].columns;
      const vals = result[0].values[0];
      const obj = {};
      cols.forEach((c, i) => obj[c] = vals[i]);
      return obj;
    }
    return { transaction_count: 0, total_sales: 0, cash_total: 0, card_total: 0, ebt_total: 0, store_credit_total: 0, total_items: 0, total_discounts: 0, total_tax: 0 };
  }
};

const userRepo = {
  async getAll() {
    const db = await getDb();
    const result = db.exec('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY role, username');
    return result.length ? result[0].values.map(row => {
      const cols = result[0].columns;
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return obj;
    }) : [];
  },

  async getById(id) {
    const db = await getDb();
    const stmt = db.prepare('SELECT id, username, display_name, role, active FROM users WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  async getByUsername(username) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1');
    stmt.bind([username]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  async verifyPin(username, pin) {
    const user = await this.getByUsername(username);
    if (!user) return null;
    if (bcrypt.compareSync(pin, user.pin)) {
      return { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
    }
    return null;
  },

  async create(user) {
    const db = await getDb();
    const hashedPin = bcrypt.hashSync(user.pin, 10);
    db.run('INSERT INTO users (username, pin, display_name, role) VALUES (?, ?, ?, ?)',
      [user.username, hashedPin, user.displayName || user.username, user.role || 'cashier']);
    saveDb();
    return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  },

  async updatePin(id, newPin) {
    const db = await getDb();
    const hashedPin = bcrypt.hashSync(newPin, 10);
    db.run('UPDATE users SET pin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashedPin, id]);
    saveDb();
  },

  async update(id, user) {
    const db = await getDb();
    db.run('UPDATE users SET display_name = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [user.displayName, user.role, id]);
    saveDb();
  },

  async deactivate(id) {
    const db = await getDb();
    db.run('UPDATE users SET active = 0 WHERE id = ?', [id]);
    saveDb();
  }
};

const shiftRepo = {
  async getOpen() {
    const db = await getDb();
    const result = db.exec("SELECT * FROM shifts WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1");
    if (result.length && result[0].values.length) {
      return rowToShift(result[0].columns, result[0].values[0]);
    }
    return null;
  },

  async open(userId, startingCash) {
    const existingOpen = await this.getOpen();
    if (existingOpen) {
      throw new Error('A shift is already open. Please close it first.');
    }
    const db = await getDb();
    db.run("INSERT INTO shifts (opened_by, starting_cash, status) VALUES (?, ?, 'open')",
      [userId, startingCash || 0]);
    saveDb();
    return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  },

  async close(shiftId, userId, endingCash, notes) {
    const shift = await this.getById(shiftId);
    if (!shift || shift.status !== 'open') {
      throw new Error('Shift is not open or does not exist.');
    }

    const sales = await salesRepo.getShiftSales(shiftId);
    let totalSales = 0, cashSales = 0, cardSales = 0, ebtSales = 0;
    for (const sale of sales) {
      totalSales += sale.total;
      if (sale.payment_type === 'Cash') cashSales += sale.total;
      else if (sale.payment_type === 'Debit Card') cardSales += sale.total;
      else if (sale.payment_type === 'EBT') ebtSales += sale.total;
    }

    const db = await getDb();
    db.run(`
      UPDATE shifts 
      SET closed_by = ?, closed_at = CURRENT_TIMESTAMP, ending_cash = ?, 
          total_sales = ?, total_transactions = ?, cash_sales = ?, card_sales = ?, ebt_sales = ?,
          notes = ?, status = 'closed'
      WHERE id = ?
    `, [userId, endingCash, totalSales, sales.length, cashSales, cardSales, ebtSales, notes, shiftId]);
    saveDb();
  },

  async getById(id) {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM shifts WHERE id = ${id}`);
    if (result.length && result[0].values.length) {
      return rowToShift(result[0].columns, result[0].values[0]);
    }
    return null;
  },

  async getRecent(limit = 10) {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM shifts ORDER BY opened_at DESC LIMIT ${limit}`);
    return result.length ? result[0].values.map(row => rowToShift(result[0].columns, row)) : [];
  }
};

const settingsRepo = {
  async get(key) {
    const db = await getDb();
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.value;
    }
    stmt.free();
    return null;
  },

  async set(key, value) {
    const db = await getDb();
    db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
      [key, value, value]);
    saveDb();
  },

  async getAll() {
    const db = await getDb();
    const result = db.exec('SELECT key, value FROM settings');
    const settings = {};
    if (result.length) {
      for (const row of result[0].values) {
        settings[row[0]] = row[1];
      }
    }
    return settings;
  }
};

const dailyReportsRepo = {
  async save(reportData) {
    const db = await getDb();
    const { report_date, total_sales, cash_sales, card_sales, ebt_sales, store_credit_sales, tax_collected, transaction_count, refund_total, report_data, created_by } = reportData;
    db.run(`INSERT INTO daily_reports (report_date, total_sales, cash_sales, card_sales, ebt_sales, store_credit_sales, tax_collected, transaction_count, refund_total, report_data, created_by) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
            ON CONFLICT(report_date) DO UPDATE SET 
            total_sales = ?, cash_sales = ?, card_sales = ?, ebt_sales = ?, store_credit_sales = ?, tax_collected = ?, transaction_count = ?, refund_total = ?, report_data = ?`,
      [report_date, total_sales, cash_sales, card_sales, ebt_sales, store_credit_sales || 0, tax_collected, transaction_count, refund_total, report_data, created_by,
       total_sales, cash_sales, card_sales, ebt_sales, store_credit_sales || 0, tax_collected, transaction_count, refund_total, report_data]);
    saveDb();
    return true;
  },

  async getByDate(date) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM daily_reports WHERE report_date = ?');
    stmt.bind([date]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  async getAll() {
    const db = await getDb();
    const result = db.exec('SELECT * FROM daily_reports ORDER BY report_date DESC');
    if (!result.length) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  },

  async getDateRange(startDate, endDate) {
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM daily_reports WHERE report_date >= ? AND report_date <= ? ORDER BY report_date DESC');
    stmt.bind([startDate, endDate]);
    const reports = [];
    while (stmt.step()) {
      reports.push(stmt.getAsObject());
    }
    stmt.free();
    return reports;
  }
};

const idChecksRepo = {
  async log(checkData) {
    const db = await getDb();
    const { check_type, dob, age, verified, min_age_required, user_id, shift_id, sale_id, notes } = checkData;
    db.run(`INSERT INTO id_checks (check_type, dob, age, verified, min_age_required, user_id, shift_id, sale_id, notes) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [check_type, dob, age, verified ? 1 : 0, min_age_required || 21, user_id, shift_id, sale_id, notes]);
    saveDb();
    return true;
  },

  async getRecent(limit = 100) {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM id_checks ORDER BY created_at DESC LIMIT ${limit}`);
    if (!result.length) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  }
};

const drawerLogRepo = {
  async log(logData) {
    const db = await getDb();
    const { reason, sale_amount, user_id, user_name, shift_id, sale_id } = logData;
    db.run(`INSERT INTO drawer_log (reason, sale_amount, user_id, user_name, shift_id, sale_id) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      [reason || 'Unknown', sale_amount || 0, user_id || 0, user_name || 'Unknown', shift_id || 0, sale_id || null]);
    saveDb();
    return true;
  },

  async getRecent(limit = 100) {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM drawer_log ORDER BY created_at DESC LIMIT ${limit}`);
    if (!result.length) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  },

  async getByDateRange(startDate, endDate) {
    const db = await getDb();
    const result = db.exec(`
      SELECT * FROM drawer_log 
      WHERE created_at >= '${startDate}' AND created_at <= '${endDate}' 
      ORDER BY created_at DESC
    `);
    if (!result.length) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  },

  async getTodayLogs() {
    const db = await getDb();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const formatForSql = (d) => d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    const startSql = formatForSql(startOfDay);
    const endSql = formatForSql(endOfDay);
    
    const result = db.exec(`
      SELECT * FROM drawer_log 
      WHERE created_at >= '${startSql}' AND created_at <= '${endSql}' 
      ORDER BY created_at DESC
    `);
    if (!result.length) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  }
};

function rowToProduct(columns, row) {
  const obj = {};
  columns.forEach((c, i) => obj[c] = row[i]);
  return obj;
}

function rowToSale(columns, row) {
  const obj = {};
  columns.forEach((c, i) => obj[c] = row[i]);
  return obj;
}

function rowToShift(columns, row) {
  const obj = {};
  columns.forEach((c, i) => obj[c] = row[i]);
  return obj;
}

function closeDatabase() {
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  getDb,
  closeDatabase,
  saveDb,
  productRepo,
  salesRepo,
  userRepo,
  shiftRepo,
  settingsRepo,
  dailyReportsRepo,
  idChecksRepo,
  drawerLogRepo,
  dbPath
};
