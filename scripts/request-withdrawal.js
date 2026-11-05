'use strict';
// MANUAL operator script — never run by cron, never automatic.
// Broadcasts an ADMIN-APPROVED withdrawal via the signer service.
// Usage (testnet only, unless SIGNER_MAINNET_ENABLED=true and you
// explicitly pass --mainnet, which is not recommended here):
//   SIGNER_URL=http://127.0.0.1:4100 SIGNER_API_SECRET=<secret> \
//   SIGNER_MANUAL_CONFIRM=yes node scripts/request-withdrawal.js --withdrawal-id 12
// The withdrawal must already be status 'approved' in PayCrypto.
// After the signer verifies the receipt, this script marks it
// 'confirmed' with the tx hash and debits the merchant ledger
// (same accounting as the admin route, exactly once per withdrawal id).
const config = require('../server/src/lib/config');
const { createStore } = require('../server/src/lib/store');
const { requestSigning } = require('../server/src/lib/signing-client');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  if (process.env.SIGNER_MANUAL_CONFIRM !== 'yes') { console.error('Refusing: set SIGNER_MANUAL_CONFIRM=yes to confirm you manually reviewed this withdrawal.'); process.exitCode = 2; return; }
  if (config.network !== 'testnet' && process.env.SIGNER_MAINNET_ENABLED !== 'true') { console.error('Refusing: this script runs on testnet only unless SIGNER_MAINNET_ENABLED=true. Mainnet is not activated.'); process.exitCode = 2; return; }
  if (config.withdrawalAutoBroadcast) { console.error('Refusing: WITHDRAWAL_AUTO_BROADCAST is true — manual script must not run while automatic broadcast is enabled.'); process.exitCode = 2; return; }
  const id = arg('--withdrawal-id');
  if (!id) { console.error('Usage: node scripts/request-withdrawal.js --withdrawal-id <id>'); process.exitCode = 2; return; }
  const signerUrl = process.env.SIGNER_URL; const apiSecret = process.env.SIGNER_API_SECRET;
  if (!signerUrl || !apiSecret) { console.error('SIGNER_URL and SIGNER_API_SECRET are required.'); process.exitCode = 2; return; }
  const store = createStore();
  const w = await store.getWithdrawalById(id);
  if (!w) { console.error('Withdrawal not found:', id); process.exitCode = 2; return; }
  if (w.status !== 'approved') { console.error(`Withdrawal ${id} is '${w.status}', not 'approved'. Approve it in Admin first.`); process.exitCode = 2; return; }
  if (w.tx_hash) { console.error(`Withdrawal ${id} already has tx_hash ${w.tx_hash} — refusing duplicate broadcast.`); process.exitCode = 2; return; }
  const result = await requestSigning({ signerUrl, apiSecret, body: { job_id: `withdrawal:${w.id}`, kind: 'withdrawal', withdrawal_id: w.id, approved_by: 'operator-script', to: w.destination_address, amount_base_units: w.net_base_units, contract: config.usdtContractForNetwork() } });
  console.log('Signer result:', result);
  if (!result.broadcast && !result.dry_run) { console.error('Signer did not broadcast and was not in dry-run mode — not marking confirmed.'); process.exitCode = 2; return; }
  if (result.dry_run) { console.log('Dry-run only: withdrawal NOT marked confirmed, ledger NOT debited. Set SIGNER_DRY_RUN=false on the signer to broadcast for real (testnet manual testing only).'); return; }
  await store.updateWithdrawal(w.id, { status: 'confirmed', tx_hash: result.tx_hash });
  try {
    await store.addLedgerEntry({ merchant_id: w.merchant_id, withdrawal_id: w.id, entry_type: 'debit', amount_base_units: String(w.amount_base_units), description: `Withdrawal ${result.tx_hash}`, reference_key: `withdrawal:${w.id}` });
  } catch (e) { if (e.code !== 'DUPLICATE') throw e; }
  await store.logAudit({ actor_type: 'system', action: 'withdrawal.broadcast', entity_type: 'withdrawal', entity_id: w.id, details: { tx_hash: result.tx_hash } });
  console.log(`Withdrawal ${w.id} confirmed on-chain: ${result.tx_hash}`);
}
if (require.main === module) main().catch((e) => { console.error('Withdrawal broadcast failed:', e.message); process.exitCode = 1; });
module.exports = { main };
