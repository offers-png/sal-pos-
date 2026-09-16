(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PosMoney = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const methods = ['Cash', 'Debit Card', 'EBT', 'Store Credit', 'EBT + Cash', 'EBT + Debit Card'];
  const cents = value => Math.round(Number(value) * 100);
  const amount = value => value / 100;
  function allocate(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    let assigned = 0, accumulated = 0;
    return weights.map(weight => {
      accumulated += weight;
      const next = sum ? Math.round(total * accumulated / sum) : 0;
      const part = next - assigned; assigned = next; return part;
    });
  }
  function calculate(items, { paymentType, discountPercentage = 0, taxRate = 0, taxEnabled = true }) {
    if (!methods.includes(paymentType)) throw Error('Invalid payment method');
    if (!Array.isArray(items) || !items.length || items.length > 500) throw Error('Cart must contain 1–500 items');
    if (!Number.isFinite(discountPercentage) || discountPercentage < 0 || discountPercentage > 100) throw Error('Invalid discount');
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) throw Error('Invalid tax rate');
    const gross = items.map(item => {
      if (!Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 10000) throw Error('Quantity must be a positive whole number');
      if (!Number.isFinite(item.price) || item.price < 0 || item.price > 1000000) throw Error('Invalid price');
      return cents(item.price) * item.qty;
    });
    const subtotal = gross.reduce((a, b) => a + b, 0);
    const discount = Math.round(subtotal * discountPercentage / 100);
    const discounts = allocate(discount, gross);
    const useEbt = paymentType.startsWith('EBT');
    if (paymentType === 'EBT' && items.some(i => !i.ebt_eligible)) throw Error('Cart contains items not eligible for EBT');
    let tax = 0, total = 0, ebt = 0;
    const lines = items.map((item, i) => {
      const net = gross[i] - discounts[i];
      const lineTax = taxEnabled && item.taxable !== false && item.taxable !== 0 && !(useEbt && item.ebt_eligible) ? Math.round(net * taxRate) : 0;
      const paid = net + lineTax;
      tax += lineTax; total += paid;
      if (useEbt && item.ebt_eligible) ebt += paid;
      return { ...item, lineId: String(i), discountCents: discounts[i], taxCents: lineTax, paidCents: paid };
    });
    const tenders = {};
    if (useEbt) tenders.EBT = ebt;
    if (paymentType.includes(' + ')) tenders[paymentType.split(' + ')[1]] = total - ebt;
    else if (!useEbt) tenders[paymentType] = total;
    return { items: lines, subtotal: amount(subtotal), discount: amount(discount), tax: amount(tax), total: amount(total), tenders, paymentType, itemCount: items.reduce((n, i) => n + i.qty, 0) };
  }
  return { cents, amount, allocate, calculate, methods };
});
