// Public pay page polling (external file, CSP-safe). The reference is
// read from a data attribute, never from an inline script.
(function () {
  const data = document.getElementById('payData');
  if (!data) return;
  const ref = data.getAttribute('data-reference');
  setInterval(async () => {
    try {
      const d = await PayCrypto.api('/api/v1/invoices/' + encodeURIComponent(ref) + '/public');
      const live = document.getElementById('live');
      if (live) live.textContent = 'Status now: ' + d.invoice.status;
    } catch {}
  }, 15000);
})();
