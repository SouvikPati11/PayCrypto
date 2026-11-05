// PayCrypto dashboard client. No secrets are stored here; the session cookie
// is httpOnly and API keys are shown once at creation, never in this file.
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
async function api(path, opts = {}) {
  const csrf = getCookie('paycrypto_csrf');
  const headers = { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(opts.headers || {}) };
  const r = await fetch(path, { headers, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || data.error || 'Request failed');
  return data;
}
function el(id) { return document.getElementById(id); }
function renderTable(target, rows, cols) {
  const t = el(target); if (!t) return;
  if (!rows.length) { t.innerHTML = '<p class="muted">No records yet.</p>'; return; }
  t.innerHTML = '<table><tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>' +
    rows.map((r) => '<tr>' + cols.map((c) => `<td>${escapeHtml(r[c])}</td>`).join('') + '</tr>').join('') + '</table>';
}
window.PayCrypto = { api, renderTable };
