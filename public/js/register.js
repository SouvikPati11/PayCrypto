// Merchant registration page (external file, CSP-safe).
(function () {
  const form = document.getElementById('regForm');
  if (!form) return;
  const el = (id) => document.getElementById(id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await PayCrypto.api('/api/auth/register', { method: 'POST', body: JSON.stringify({ businessName: el('business').value, email: el('email').value, password: el('password').value, website: el('website').value || undefined }) });
      el('msg').innerHTML = '<div class="alert">Account created — pending admin approval. You can now <a href="/login">log in</a>.</div>';
    } catch (err) { el('msg').textContent = err.message; el('msg').className = 'alert bad'; }
  };
})();
