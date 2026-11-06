// Admin password recovery page (external file, CSP-safe).
// Sends the recovery code and the new password to the server; neither is
// ever written to the page, localStorage, or the URL.
(function () {
  const form = document.getElementById('recoverForm');
  if (!form) return;
  const el = (id) => document.getElementById(id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const msg = el('msg');
    if (el('newPassword').value !== el('confirmPassword').value) {
      msg.textContent = 'The new passwords do not match.';
      msg.className = 'alert bad';
      return;
    }
    try {
      const d = await PayCrypto.api('/api/auth/admin-recover', { method: 'POST', body: JSON.stringify({ email: el('email').value, recovery_code: el('code').value, new_password: el('newPassword').value }) });
      msg.textContent = d.message || 'Admin password reset.';
      msg.className = 'alert';
      form.reset();
    } catch (err) { msg.textContent = err.message; msg.className = 'alert bad'; }
  };
})();
