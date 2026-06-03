const EodReportsService = {
  async fetchTodayReport() {
    const res = await fetch("/api/eod-today");
    const data = await res.json();
    return data;
  },

  async fetchWeekReports() {
    const res = await fetch("/api/daily-reports-week");
    const data = await res.json();
    return data;
  },

  async fetchReportByDate(date) {
    const res = await fetch(`/api/daily-reports/${date}`);
    const data = await res.json();
    return data;
  },

  async saveReport() {
    const res = await fetch("/api/daily-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    return res;
  },

  formatReportTableHtml(data) {
    const t = data.totals || {};
    const c = data.counts || {};
    const grand = data.grandTotal || 0;
    const txCount = data.transactionCount || 0;

    return `
      <table class="eod-table" style="width: 100%; border-collapse: collapse; font-family: 'Courier New', monospace;">
        <thead>
          <tr style="border-bottom: 2px solid currentColor;">
            <th style="text-align: left; padding: 8px;">Type</th>
            <th style="text-align: center; padding: 8px;">#Trn</th>
            <th style="text-align: right; padding: 8px;">$Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">Cash</td>
            <td style="text-align: center; padding: 8px;">${c["Cash"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["Cash"] || 0).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">Debit Card</td>
            <td style="text-align: center; padding: 8px;">${c["Debit Card"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["Debit Card"] || 0).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">EBT</td>
            <td style="text-align: center; padding: 8px;">${c["EBT"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["EBT"] || 0).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">Store Credit</td>
            <td style="text-align: center; padding: 8px;">${c["Store Credit"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["Store Credit"] || 0).toFixed(2)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid currentColor; font-weight: bold;">
            <td style="padding: 8px;">TOTAL</td>
            <td style="text-align: center; padding: 8px;">${txCount}</td>
            <td style="text-align: right; padding: 8px;">$${grand.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    `;
  },

  formatHistoryReportHtml(report) {
    const t = report.totals || {};
    const c = report.counts || {};
    const grand = report.grandTotal || 0;
    const txCount = report.transactionCount || 0;

    return `
      <table class="eod-table" style="width: 100%; border-collapse: collapse; font-family: 'Courier New', monospace;">
        <thead>
          <tr style="border-bottom: 2px solid currentColor;">
            <th style="text-align: left; padding: 8px;">Type</th>
            <th style="text-align: center; padding: 8px;">#Trn</th>
            <th style="text-align: right; padding: 8px;">$Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">Cash</td>
            <td style="text-align: center; padding: 8px;">${c["Cash"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["Cash"] || 0).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">Debit Card</td>
            <td style="text-align: center; padding: 8px;">${c["Debit Card"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["Debit Card"] || 0).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">EBT</td>
            <td style="text-align: center; padding: 8px;">${c["EBT"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["EBT"] || 0).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom: 1px dashed currentColor;">
            <td style="padding: 8px;">Store Credit</td>
            <td style="text-align: center; padding: 8px;">${c["Store Credit"] || 0}</td>
            <td style="text-align: right; padding: 8px;">$${(t["Store Credit"] || 0).toFixed(2)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid currentColor; font-weight: bold;">
            <td style="padding: 8px;">TOTAL</td>
            <td style="text-align: center; padding: 8px;">${txCount}</td>
            <td style="text-align: right; padding: 8px;">$${grand.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    `;
  },

  buildPrintLines(data) {
    const t = data.totals || {};
    const c = data.counts || {};
    const grand = data.grandTotal || 0;
    const txCount = data.transactionCount || 0;
    const now = new Date();
    const dateStr = now.toLocaleDateString();
    const timeStr = now.toLocaleTimeString();

    return [
      '',
      '========================================',
      '         SHAMROCK MARKET',
      '         End of Day Report',
      '========================================',
      '',
      `Date: ${dateStr}`,
      `Time: ${timeStr}`,
      '',
      '----------------------------------------',
      'Payment Type         #Trn      Amount',
      '----------------------------------------',
      `Cash                 ${String(c["Cash"] || 0).padStart(4)}    $${(t["Cash"] || 0).toFixed(2).padStart(8)}`,
      `Debit Card           ${String(c["Debit Card"] || 0).padStart(4)}    $${(t["Debit Card"] || 0).toFixed(2).padStart(8)}`,
      `EBT                  ${String(c["EBT"] || 0).padStart(4)}    $${(t["EBT"] || 0).toFixed(2).padStart(8)}`,
      `Store Credit         ${String(c["Store Credit"] || 0).padStart(4)}    $${(t["Store Credit"] || 0).toFixed(2).padStart(8)}`,
      '----------------------------------------',
      `TOTAL                ${String(txCount).padStart(4)}    $${grand.toFixed(2).padStart(8)}`,
      '========================================',
      '',
      '  *** End of Day ***',
      ''
    ];
  },

  buildPrintHtml(data) {
    const lines = this.buildPrintLines(data);
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>End of Day Report</title>
        <style>
          body { font-family: 'Courier New', monospace; font-size: 12px; padding: 10px; }
          pre { white-space: pre-wrap; margin: 0; }
        </style>
      </head>
      <body>
        <pre>${lines.join('\n')}</pre>
      </body>
      </html>
    `;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EodReportsService;
}
