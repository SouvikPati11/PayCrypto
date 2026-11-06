'use strict';
// Creates the first super_admin from ADMIN_EMAIL / ADMIN_PASSWORD env vars.
// Change the password immediately after first login and enable 2FA.
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long-random' node scripts/seed-admin.js
//
// Safety rules (see docs/ADMIN_RECOVERY.md for why each exists):
// - Email is normalised (trim + lowercase) exactly like login, so an
//   ADMIN_EMAIL pasted with a leading space or uppercase cannot create
//   an account that login can never find.
// - The password is used EXACTLY as given — never trimmed. A password
//   with a trailing space is a different password; if the value you set
//   is altered on the way in (shell $ expansion, quotes, whitespace),
//   the stored hash will not match the password you believe you set.
//   Enter it with read -s or single quotes, never unquoted.
// - Refuses to run with MEMORY_DB=true: that would create the admin in
//   an in-memory store that vanishes on restart, while reporting success.
// - Idempotent: if the email already exists, it prints that and changes
//   nothing — it never resets a password. Use POST /api/auth/admin-recover
//   (docs/ADMIN_RECOVERY.md) to reset a super_admin password instead.
// - Default settings are only written for keys that are not already set,
//   so a wallet_xpub or treasury_address set earlier is never wiped.
const config = require('../server/src/lib/config');
const { createStore } = require('../server/src/lib/store');
const { normalizeEmail, hashPassword } = require('../server/src/lib/auth');

async function main(storeArg) {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (config.memoryDb) { console.error('Refusing to seed with MEMORY_DB=true: the admin would be created in memory only and lost on restart. Unset MEMORY_DB and run against MySQL.'); return { ok: false, reason: 'MEMORY_DB' }; }
  if (!email || !password || password.length < 10) { console.error('Set ADMIN_EMAIL and a ADMIN_PASSWORD of at least 10 chars.'); return { ok: false, reason: 'MISSING_OR_SHORT' }; }
  const store = storeArg || createStore();
  const existing = await store.findUserByEmail(email);
  if (existing) { console.log('Admin already exists:', email); return { ok: true, alreadyExists: true }; }
  const user = await store.createUser({ email, password_hash: await hashPassword(password), role: 'super_admin', merchant_id: null });
  // Seed default settings only where none exists yet (idempotent in MySQL
  // via ON DUPLICATE KEY, and non-destructive here for existing values).
  const defaults = {
    network: config.network, chain_id: String(config.chainId), usdt_contract: config.usdtContractForNetwork() || '',
    confirmations: String(config.confirmations), invoice_expiry_minutes: String(config.invoiceExpiryMinutes),
    min_withdrawal_usdt: config.minWithdrawalUsdt, max_withdrawal_usdt: config.maxWithdrawalUsdt,
    withdrawal_fee_usdt: config.withdrawalFeeUsdt, maintenance_mode: 'false', emergency_pause: 'false',
    treasury_address: config.treasuryAddress, wallet_xpub: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    const current = await store.getSetting(k);
    if (current === null || current === undefined || current === '') await store.setSetting(k, v);
  }
  console.log('Super admin created:', user.email, '— change the password and enable 2FA now.');
  return { ok: true, email: user.email };
}
if (require.main === module) {
  // Exit explicitly: the MySQL pool keeps the event loop alive otherwise,
  // so the script would print success and then hang until the terminal
  // session ends. (main() itself stays exit-code-free so tests can call it.)
  main().then((r) => { process.exit(r.ok ? 0 : 2); }).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { main };
