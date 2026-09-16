const crypto = require('crypto');
const money = require('./money');
const database = () => require('../database');
function rows(db, sql, args = []) {
  const stmt = db.prepare(sql);
  try { stmt.bind(args); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); return result; }
  finally { stmt.free(); }
}
function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw Error('A valid idempotency key is required');
  return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stock(db, item, delta, reason, userId) {
  if (!item.barcode) return;
  const p = rows(db, 'SELECT * FROM products WHERE barcode = ?', [item.barcode])[0];
  if (!p) throw Error('Product no longer exists');
  const next = p.stock + delta;
  db.run('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [next, p.id]);
  db.run('INSERT INTO inventory_log (product_id, change_type, quantity_change, previous_stock, new_stock, reason, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [p.id, delta < 0 ? 'subtract' : 'add', delta, p.stock, next, reason, userId]);
}
async function sale(body, userId) {
  const db = await database().getDb();
  const saleId = key(body.idempotencyKey);
  const fingerprint = hash({ items: body.items, paymentType: body.paymentType, discountPercentage: body.discountPercentage, taxEnabled: body.taxEnabled, total: body.total });
  const previous = rows(db, 'SELECT * FROM sales WHERE sale_id = ?', [saleId])[0];
  if (previous) {
    if (previous.request_hash !== fingerprint) throw Error('Idempotency key was already used for a different sale');
    return { ...receipt(previous), duplicate: true };
  }
  if (!Array.isArray(body.items)) throw Error('Items required');
  const items = [];
  for (const input of body.items) {
    if (!input || typeof input !== 'object') throw Error('Invalid item');
    let product;
    if (input.barcode) {
      product = await database().productRepo.getByBarcode(String(input.barcode));
      if (!product || !product.active) throw Error('Product not found: ' + input.barcode);
    } else {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw Error('Manual item name required');
      product = { name: input.name, price: input.price, category: 'Other / Misc', taxable: true, ebt_eligible: false, barcode: '' };
    }
    items.push({ barcode: product.barcode, name: product.name, category: product.category, price: Number(product.price), qty: input.qty, taxable: product.taxable !== 0 && product.taxable !== false, ebt_eligible: !!product.ebt_eligible });
  }
  const settings = await database().settingsRepo.getAll();
  const calculated = money.calculate(items, { paymentType: body.paymentType, discountPercentage: body.discountPercentage, taxRate: Number(settings.tax_rate || 0), taxEnabled: body.taxEnabled !== false });
  // Reject stale prices/tax settings rather than charging a different amount silently.
  if (!Number.isFinite(body.total) || money.cents(body.total) !== money.cents(calculated.total)) throw Error('Cart total changed. Reload products and review the total before retrying.');
  const shift = rows(db, "SELECT id FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1")[0];
  return database().transaction(db => {
    db.run('INSERT INTO sales (sale_id, items, subtotal, discount, tax, total, payment_type, item_count, user_id, shift_id, tenders, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [saleId, JSON.stringify(calculated.items), calculated.subtotal, calculated.discount, calculated.tax, calculated.total, calculated.paymentType, calculated.itemCount, userId, shift?.id || 0, JSON.stringify(calculated.tenders), fingerprint]);
    for (const item of calculated.items) stock(db, item, -item.qty, 'sale', userId);
    return { saleId, ...calculated, duplicate: false };
  });
}
function receipt(sale) {
  return { saleId: sale.sale_id, items: JSON.parse(sale.items), subtotal: sale.subtotal, discount: sale.discount, tax: sale.tax, total: sale.total, paymentType: sale.payment_type, tenders: JSON.parse(sale.tenders || '{}'), itemCount: sale.item_count };
}
function saleLines(sale) {
  const lines = JSON.parse(sale.items);
  const weights = lines.map(i => money.cents(i.price) * i.qty);
  const paid = money.allocate(money.cents(sale.total), weights);
  const tax = money.allocate(money.cents(sale.tax), weights);
  return lines.map((i, n) => ({ ...i, lineId: i.lineId ?? String(n), paidCents: i.paidCents ?? paid[n], taxCents: i.taxCents ?? tax[n] }));
}
function returnedQuantities(returns, lines) {
  const quantities = {};
  for (const ret of returns) for (const item of JSON.parse(ret.items)) {
    const line = item.lineId == null ? lines.find(i => i.barcode === item.barcode && i.name === item.name) : lines.find(i => i.lineId === item.lineId);
    if (line) quantities[line.lineId] = (quantities[line.lineId] || 0) + item.qty;
  }
  return quantities;
}
async function lookup(saleId) {
  const db = await database().getDb();
  const sale = rows(db, 'SELECT * FROM sales WHERE sale_id = ?', [saleId])[0];
  if (!sale) throw Error('Sale not found');
  const items = saleLines(sale);
  const prior = rows(db, 'SELECT * FROM returns WHERE original_sale_id = ?', [saleId]);
  return { ...receipt(sale), items, alreadyReturned: returnedQuantities(prior, items), voided: !!sale.voided, createdAt: sale.created_at };
}
async function refund(saleId, body, userId) {
  await database().getDb();
  const returnId = 'RET-' + key(body.idempotencyKey);
  const fingerprint = hash({ saleId, items: body.items, refundMethod: body.refundMethod, reason: body.reason || '' });
  return database().transaction(db => {
    const previous = rows(db, 'SELECT * FROM returns WHERE return_id = ?', [returnId])[0];
    if (previous) {
      if (previous.request_hash !== fingerprint) throw Error('Idempotency key already used');
      return { returnId, refundAmount: previous.refund_amount, duplicate: true };
    }
    const sale = rows(db, 'SELECT * FROM sales WHERE sale_id = ?', [saleId])[0];
    if (!sale || sale.voided) throw Error('Sale not found or voided');
    if (!Array.isArray(body.items) || !body.items.length) throw Error('Return items required');
    if (!money.methods.slice(0, 4).includes(body.refundMethod)) throw Error('Invalid refund method');
    const lines = saleLines(sale);
    const prior = rows(db, 'SELECT * FROM returns WHERE original_sale_id = ?', [saleId]);
    const returned = returnedQuantities(prior, lines);
    const requested = new Map();
    for (const item of body.items) {
      const lineId = String(item.lineId);
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0) throw Error('Invalid return quantity');
      requested.set(lineId, (requested.get(lineId) || 0) + item.qty);
    }
    let refundCents = 0, taxCents = 0;
    const valid = [];
    for (const [lineId, qty] of requested) {
      const line = lines.find(i => i.lineId === lineId);
      const done = returned[lineId] || 0;
      if (!line || qty + done > line.qty) throw Error('Return quantity exceeds remaining purchased quantity');
      const partial = value => Math.round(value * (done + qty) / line.qty) - Math.round(value * done / line.qty);
      const paid = partial(line.paidCents), tax = partial(line.taxCents);
      refundCents += paid; taxCents += tax;
      valid.push({ ...line, qty, paidCents: paid, taxCents: tax });
    }
    if (refundCents + prior.reduce((n, r) => n + money.cents(r.refund_amount), 0) > money.cents(sale.total)) throw Error('Refund exceeds original payment');
    const tenders = sale.tenders ? JSON.parse(sale.tenders) : { [sale.payment_type]: money.cents(sale.total) };
    const refundedMethod = prior.filter(r => r.refund_method === body.refundMethod).reduce((n, r) => n + money.cents(r.refund_amount), 0);
    if (!Number.isFinite(tenders[body.refundMethod]) || refundCents + refundedMethod > tenders[body.refundMethod]) throw Error('Refund exceeds the amount paid with this method; select fewer items or the original tender');
    const shift = rows(db, "SELECT id FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1")[0];
    db.run('INSERT INTO returns (return_id, original_sale_id, items, refund_amount, refund_method, reason, user_id, shift_id, request_hash, refund_tax) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [returnId, saleId, JSON.stringify(valid), money.amount(refundCents), body.refundMethod, String(body.reason || '').slice(0, 1000), userId, shift?.id || 0, fingerprint, money.amount(taxCents)]);
    for (const item of valid) stock(db, item, item.qty, 'return', userId);
    return { returnId, refundAmount: money.amount(refundCents), duplicate: false };
  });
}
function summarize(db, where, args) {
  const sales = rows(db, 'SELECT * FROM sales WHERE voided = 0 AND ' + where, args);
  const returns = rows(db, 'SELECT * FROM returns WHERE ' + where, args);
  const totals = { Cash: 0, 'Debit Card': 0, EBT: 0, 'Store Credit': 0 };
  let gross = 0, tax = 0, discounts = 0, count = 0, unallocated = 0, refunds = 0;
  for (const sale of sales) {
    gross += money.cents(sale.total); tax += money.cents(sale.tax); discounts += money.cents(sale.discount); count += sale.item_count;
    if (sale.tenders) for (const [method, value] of Object.entries(JSON.parse(sale.tenders))) totals[method] += value;
    else if (sale.payment_type in totals) totals[sale.payment_type] += money.cents(sale.total);
    else unallocated += money.cents(sale.total);
  }
  for (const ret of returns) { const value = money.cents(ret.refund_amount); refunds += value; tax -= money.cents(ret.refund_tax || 0); if (ret.refund_method in totals) totals[ret.refund_method] -= value; }
  return { total_sales: money.amount(gross - refunds), gross_sales: money.amount(gross), refund_total: money.amount(refunds), total_tax: money.amount(tax), total_discounts: money.amount(discounts), total_items: count, transaction_count: sales.length, cash_total: money.amount(totals.Cash), card_total: money.amount(totals['Debit Card']), ebt_total: money.amount(totals.EBT), store_credit_total: money.amount(totals['Store Credit']), unallocated_total: money.amount(unallocated) };
}
async function voidSale(saleId, reason, userId) {
  await database().getDb();
  return database().transaction(db => {
    const sale = rows(db, 'SELECT * FROM sales WHERE sale_id = ?', [saleId])[0];
    if (!sale) throw Error('Sale not found');
    if (sale.voided) return;
    if (rows(db, 'SELECT id FROM returns WHERE original_sale_id = ?', [saleId]).length) throw Error('Cannot void a sale with returns');
    for (const item of JSON.parse(sale.items)) stock(db, item, item.qty, 'void', userId);
    db.run('UPDATE sales SET voided = 1, void_reason = ? WHERE sale_id = ?', [String(reason || 'Void'), saleId]);
  });
}
module.exports = { sale, refund, lookup, summarize, voidSale, rows };
