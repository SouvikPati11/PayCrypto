'use strict';
// Creates the first super_admin from ADMIN_EMAIL / ADMIN_PASSWORD env vars.
// Change the password immediately after first login and enable 2FA.
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long-random' node scripts/seed-admin.js
const config = require('../server/src/lib/config');
const { createStore } = require('../server/src/lib/store');
const { hashPassword } = require('../server/src/lib/auth');

async function main() {
  const email = process.env.ADMIN_EMAIL; const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 10) { console.error('Set ADMIN_EMAIL and a ADMIN_PASSWORD of at least 10 chars.'); process.exitCode = 2; return; }
  const store = createStore();
  const existing = await store.findUserByEmail(email);
  if (existing) { console.log('Admin already exists:', email); return; }
  const user = await store.createUser({ email, password_hash: await hashPassword(password), role: 'super_admin', merchant_id: null });
  // Seed default settings (idempotent in MySQL via ON DUPLICATE KEY).
  const defaults = {
    network: config.network, chain_id: String(config.chainId), usdt_contract: config.usdtContractForNetwork() || '',
    confirmations: String(config.confirmations), invoice_expiry_minutes: String(config.invoiceExpiryMinutes),
    min_withdrawal_usdt: config.minWithdrawalUsdt, max_withdrawal_usdt: config.maxWithdrawalUsdt,
    withdrawal_fee_usdt: config.withdrawalFeeUsdt, maintenance_mode: 'false', emergency_pause: 'false',
    treasury_address: config.treasuryAddress, wallet_xpub: '',
  };
  for (const [k, v] of Object.entries(defaults)) await store.setSetting(k, v);
  console.log('Super admin created:', user.email, '— change the password and enable 2FA now.');
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
