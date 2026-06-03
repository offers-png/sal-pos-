/**
 * Receipt Service - Manages last receipt state for reprinting
 */
const ReceiptService = {
  _lastReceipt: null,

  setLastReceipt(data) {
    this._lastReceipt = data;
  },

  getLastReceipt() {
    return this._lastReceipt;
  },

  hasLastReceipt() {
    return this._lastReceipt !== null;
  },

  clearLastReceipt() {
    this._lastReceipt = null;
  }
};

if (typeof window !== 'undefined') {
  window.ReceiptService = ReceiptService;
}
