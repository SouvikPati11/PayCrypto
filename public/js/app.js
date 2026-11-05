// PayCrypto dashboard client. No secrets are stored here; the session cookie
// is httpOnly and API keys are shown once at creation, never in this file.
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || data.error || 'Request failed');
  return data;
}
function el(id) { return document.getElementById(id); }
function renderTable(target, rows, cols) {
  const t = el(target); if (!t) return;
  if (!rows.length) { t.innerHTML = '<p class="muted">No records yet.</p>'; return; }
  t.innerHTML = '<table><tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>' +
    rows.map((r) => '<tr>' + cols.map((c) => `<td>${r[c] ?? ''}</td>`).join('') + '</tr>').join('') + '</table>';
}
window.PayCrypto = { api, renderTable };
