/* Shared browser security and session handling. */
window.SafeHtml = { clean: html => DOMPurify.sanitize(String(html), { ADD_ATTR: ['target'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed'], FORBID_ATTR: ['srcdoc'] }) };
window.PosUI = {
  ask(title, fields) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'posPrompt';
      overlay.addEventListener('keydown', e => e.stopPropagation());
      overlay.style.cssText = 'position:fixed;inset:0;background:#000b;z-index:99999;display:grid;place-items:center;color:#172033';
      const form = document.createElement('form');
      form.style.cssText = 'background:white;padding:24px;border-radius:12px;width:340px;display:grid;gap:12px;font-family:sans-serif';
      const heading = document.createElement('h2'); heading.textContent = title; form.append(heading);
      for (const field of fields) {
        const label = document.createElement('label'); label.textContent = field.label;
        const input = document.createElement('input'); input.name = field.name; input.type = field.secret ? 'password' : 'text'; input.required = true;
        input.style.cssText = 'width:100%;padding:10px;box-sizing:border-box'; label.append(input); form.append(label);
      }
      const submit = document.createElement('button'); submit.textContent = 'Continue'; submit.type = 'submit'; form.append(submit);
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.type = 'button'; cancel.onclick = () => { overlay.remove(); resolve(null); }; form.append(cancel);
      form.onsubmit = e => { e.preventDefault(); const result = Object.fromEntries(new FormData(form)); overlay.remove(); resolve(result); };
      overlay.append(form); document.body.append(overlay); form.querySelector('input').focus();
    });
  }
};
(() => {
  const original = window.fetch.bind(window);
  window.fetch = async function (url, options = {}) {
    let response = await original(url, options);
    const api = new URL(typeof url === 'string' ? url : url.url, location.href);
    if (api.origin !== location.origin || !api.pathname.startsWith('/api/')) return response;
    if (response.status === 403) {
      const data = await response.clone().json().catch(() => ({}));
      if (data.error === 'Manager authorization required') {
        const answer = await PosUI.ask('Manager authorization', [{ name: 'pin', label: 'Manager PIN', secret: true }]);
        if (answer) {
          const verified = await original('/api/auth/verify-manager-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
          const token = await verified.json();
          if (token.authorized) { const headers = new Headers(options.headers); headers.set('x-manager-token', token.accessToken); response = await original(url, { ...options, headers }); }
        }
      }
    }
    if (api.pathname === '/api/auth/login' && response.ok) {
      const data = await response.clone().json();
      if (data.mustChangePin) {
        let changed = false;
        while (!changed) {
          const answer = await PosUI.ask('Replace the default PIN', [{ name: 'newPin', label: 'New PIN (6–12 digits)', secret: true }]);
          if (!answer) { await original('/api/auth/logout', { method: 'POST' }); return new Response(JSON.stringify({ success: false, error: 'A new PIN is required' }), { status: 403 }); }
          const result = await original('/api/auth/change-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...answer, pin: JSON.parse(options.body).pin }) });
          changed = result.ok;
        }
      }
    }
    if (api.pathname === '/api/eod-today' && response.ok) {
      const report = await response.clone().json();
      let notice = document.getElementById('legacyTenderNotice');
      if (report.unallocatedTotal && !notice) {
        notice = document.createElement('div'); notice.id = 'legacyTenderNotice';
        notice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fff3cd;color:#513d00;padding:12px;z-index:9000';
        document.body.append(notice);
      }
      if (notice) { notice.textContent = 'Legacy split tender amounts need reconciliation: $' + Number(report.unallocatedTotal || 0).toFixed(2); notice.hidden = !report.unallocatedTotal; }
    }
    if (response.status === 401 && !api.pathname.startsWith('/api/auth/') && !location.pathname.endsWith('login.html')) {
      sessionStorage.removeItem('user'); location.href = '/login.html';
    }
    return response;
  };
  document.addEventListener('DOMContentLoaded', async () => {
    if (!location.pathname.endsWith('login.html') && location.pathname !== '/') return;
    const status = await original('/api/auth/setup').then(r => r.json()).catch(() => ({}));
    if (!status.setupRequired) return;
    while (true) {
      const answer = await PosUI.ask('Create the store owner', [{ name: 'username', label: 'Username' }, { name: 'pin', label: 'PIN (6–12 digits)', secret: true }]);
      if (!answer) return;
      const result = await original('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
      const data = await result.json();
      if (result.ok) { sessionStorage.setItem('user', JSON.stringify(data.user)); location.href = '/index.html'; return; }
    }
  });
})();
