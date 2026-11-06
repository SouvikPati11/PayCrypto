// Admin dashboard (external file, CSP-safe).
// Action buttons use data-* attributes + a delegated listener, not
// inline onclick handlers, so a strict CSP and the escaped renderTable
// can both hold. The 'approve' column is the only raw column, and its
// HTML is generated here from numeric ids and our own status enums —
// never from merchant-supplied text, which stays escaped.
(function () {
  const el = (id) => document.getElementById(id);
  (async () => {
    try {
      const m = await PayCrypto.api('/api/admin/merchants');
      el('mCount').textContent = m.merchants.length;
      PayCrypto.renderTable('mTable', m.merchants.map((x) => ({ id: x.id, business: x.business_name, status: x.status, approve: '<button data-action="merchant" data-id="' + x.id + '" data-status="approved">Approve</button> <button data-action="merchant" data-id="' + x.id + '" data-status="suspended">Suspend</button>' })), ['id', 'business', 'status', 'approve'], { raw: ['approve'] });
      const w = await PayCrypto.api('/api/admin/withdrawals');
      el('wCount').textContent = w.withdrawals.filter((x) => x.status === 'pending').length;
      PayCrypto.renderTable('wTable', w.withdrawals.map((x) => ({ id: x.id, merchant: x.merchant_id, amount: x.amount_base_units, status: x.status, approve: '<button data-action="withdrawal" data-id="' + x.id + '" data-status="approved">Approve</button> <button data-action="withdrawal" data-id="' + x.id + '" data-status="rejected">Reject</button>' })), ['id', 'merchant', 'amount', 'status', 'approve'], { raw: ['approve'] });
      const inv = await PayCrypto.api('/api/admin/invoices');
      el('iCount').textContent = inv.invoices.length;
      const a = await PayCrypto.api('/api/admin/audit');
      PayCrypto.renderTable('aTable', a.logs.map((x) => ({ action: x.action, entity: x.entity_type, at: x.created_at })), ['action', 'entity', 'at']);
    } catch (e) {
      // No session, expired/invalid token, or a merchant opening the admin
      // dashboard: send them to login instead of showing an empty page.
      if (e.status === 401 || e.status === 403) { location.href = '/login'; return; }
      document.body.insertAdjacentHTML('beforeend', '<p class="muted">Admin dashboard could not load: ' + PayCrypto.escapeHtml(e.message) + ' <a href="/login">Login</a></p>');
    }
  })();
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const status = btn.getAttribute('data-status');
    try {
      if (btn.getAttribute('data-action') === 'merchant') await PayCrypto.api('/api/admin/merchants/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
      else await PayCrypto.api('/api/admin/withdrawals/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
      location.reload();
    } catch (err) { alert(err.message); }
  });
})();
