// Merchant dashboard (external file, CSP-safe). All values rendered from
// the API go through PayCrypto.renderTable (escaped) or escapeHtml.
(function () {
  const el = (id) => document.getElementById(id);
  (async () => {
    try {
      const b = await PayCrypto.api('/api/v1/balance');
      el('bal').textContent = b.available_usdt + ' USDT';
      const inv = await PayCrypto.api('/api/v1/invoices');
      el('invCount').textContent = inv.invoices.length;
      PayCrypto.renderTable('invTable', inv.invoices.map((i) => ({ reference: i.reference, amount: i.amount_usdt || i.amount_base_units, status: i.status, address: i.deposit_address || '' })), ['reference', 'amount', 'status', 'address']);
      const wd = await PayCrypto.api('/api/v1/withdrawals');
      PayCrypto.renderTable('wdTable', wd.withdrawals.map((w) => ({ id: w.id, amount: w.amount_base_units, status: w.status, destination: w.destination_address })), ['id', 'amount', 'status', 'destination']);
      const ks = await PayCrypto.api('/api/v1/api-keys');
      PayCrypto.renderTable('keyTable', ks.api_keys.map((k) => ({ name: k.name, prefix: k.key_prefix, live: k.live ? 'live' : 'test' })), ['name', 'prefix', 'live']);
      const wh = await PayCrypto.api('/api/v1/webhooks');
      PayCrypto.renderTable('whTable', wh.webhooks.map((w) => ({ url: w.url, active: w.active ? 'yes' : 'no' })), ['url', 'active']);
    } catch (e) {
      document.body.insertAdjacentHTML('beforeend', '<p class="muted">Login required for dashboard data. <a href="/login">Login</a></p>');
    }
  })();
  const invForm = el('invForm');
  if (invForm) invForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await PayCrypto.api('/api/v1/invoices', { method: 'POST', body: JSON.stringify({ amount: el('amount').value, customerEmail: el('custEmail').value || undefined }) });
      el('invResult').innerHTML = '<div class="alert">Invoice <b>' + PayCrypto.escapeHtml(d.invoice.reference) + '</b> — send <b>' + PayCrypto.escapeHtml(d.invoice.amount_usdt) + ' USDT (BEP20)</b> to <code class="mono">' + PayCrypto.escapeHtml(d.invoice.deposit_address) + '</code><br><a href="/pay/' + PayCrypto.escapeHtml(d.invoice.reference) + '">Open pay page</a></div>';
    } catch (err) { const m = el('msg'); m.textContent = err.message; m.className = 'alert bad'; }
  };
  const wdForm = el('wdForm');
  if (wdForm) wdForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await PayCrypto.api('/api/v1/withdrawals', { method: 'POST', body: JSON.stringify({ destination: el('dest').value, amount: el('wdAmount').value }) });
      el('wdMsg').innerHTML = '<div class="alert">Withdrawal requested — pending admin approval.</div>';
    } catch (err) { const m = el('wdMsg'); m.textContent = err.message; m.className = 'alert bad'; }
  };
  const keyBtn = el('createKeyBtn');
  if (keyBtn) keyBtn.onclick = async () => {
    try {
      const d = await PayCrypto.api('/api/v1/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Default' }) });
      el('newKey').innerHTML = '<code class="mono">' + PayCrypto.escapeHtml(d.plaintext) + '</code> — copy now, it will not be shown again.';
    } catch (e) { alert(e.message); }
  };
  const whForm = el('whForm');
  if (whForm) whForm.onsubmit = async (e) => {
    e.preventDefault();
    try { await PayCrypto.api('/api/v1/webhooks', { method: 'POST', body: JSON.stringify({ url: el('whUrl').value }) }); alert('Webhook saved'); } catch (err) { alert(err.message); }
  };
})();
