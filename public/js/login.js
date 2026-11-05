// Login page (external file, so a strict CSP can allow script-src 'self').
(function () {
  const form = document.getElementById('loginForm');
  if (!form) return;
  const el = (id) => document.getElementById(id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await PayCrypto.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: el('email').value, password: el('password').value, totp: el('totp').value || undefined }) });
      location.href = d.user.role === 'merchant' ? '/merchant' : '/admin';
    } catch (err) { el('msg').textContent = err.message; el('msg').className = 'alert bad'; }
  };
})();
