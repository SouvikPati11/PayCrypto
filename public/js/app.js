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
  if (!r.ok) { const err = new Error(data.error?.message || data.error || 'Request failed'); err.status = r.status; throw err; }
  return data;
}
function el(id) { return document.getElementById(id); }
// PHASE 2: renderTable escapes every cell by default. Only columns listed
// in options.raw are inserted as HTML, and callers may use raw ONLY for
// HTML they generate themselves from ids/enums — never for user text.
// This fixes the Phase 1 regression where admin Approve/Suspend buttons
// (generated HTML) were escaped into visible text.
function renderTable(target, rows, cols, options = {}) {
  const raw = new Set(options.raw || []);
  const t = el(target); if (!t) return;
  if (!rows.length) { t.innerHTML = '<p class="muted">No records yet.</p>'; return; }
  t.innerHTML = '<table><tr>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>' +
    rows.map((r) => '<tr>' + cols.map((c) => `<td>${raw.has(c) ? (r[c] ?? '') : escapeHtml(r[c])}</td>`).join('') + '</tr>').join('') + '</table>';
}
// Shared logout button (present on the merchant and admin dashboards).
// The session cookie is httpOnly, so logout is a POST, not a link.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('logoutBtn');
  if (!btn) return;
  btn.onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    location.href = '/login';
  };
});
window.PayCrypto = { api, renderTable, escapeHtml };
