'use strict';
// MANUAL operator script — never run by cron, never automatic.
// Sweeps one deposit address to treasury via the signer service.
// Usage (testnet only, unless SIGNER_MAINNET_ENABLED=true):
//   SIGNER_URL=http://127.0.0.1:4100 SIGNER_API_SECRET=<secret> \
//   SIGNER_MANUAL_CONFIRM=yes node scripts/request-sweep.js \
//     --job-key sweep-2026-11-05-001 --deposit-index 0 --amount 10.5
// The sweep job must exist in PayCrypto (Admin -> Sweeps) and the
// destination is forced to the configured treasury by the signer.
// Amount is in USDT (human units, 18 decimals), for one deposit index.
// For a multi-address sweep, run once per deposit index with a
// distinct job_key per index.
const config = require('../server/src/lib/config');
const { createStore } = require('../server/src/lib/store');
const { requestSigning } = require('../server/src/lib/signing-client');
const { parseUsdt } = require('../server/src/lib/money');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  if (process.env.SIGNER_MANUAL_CONFIRM !== 'yes') { console.error('Refusing: set SIGNER_MANUAL_CONFIRM=yes to confirm you manually reviewed this sweep.'); process.exitCode = 2; return; }
  if (config.network !== 'testnet' && process.env.SIGNER_MAINNET_ENABLED !== 'true') { console.error('Refusing: this script runs on testnet only unless SIGNER_MAINNET_ENABLED=true. Mainnet is not activated.'); process.exitCode = 2; return; }
  if (config.autoSweep) { console.error('Refusing: AUTO_SWEEP is true — manual script must not run while automatic sweeping is enabled.'); process.exitCode = 2; return; }
  const jobKey = arg('--job-key'); const index = Number(arg('--deposit-index')); const amount = arg('--amount');
  if (!jobKey || !Number.isInteger(index) || index < 0 || !amount) { console.error('Usage: node scripts/request-sweep.js --job-key <key> --deposit-index <n> --amount <USDT>'); process.exitCode = 2; return; }
  const signerUrl = process.env.SIGNER_URL; const apiSecret = process.env.SIGNER_API_SECRET;
  if (!signerUrl || !apiSecret) { console.error('SIGNER_URL and SIGNER_API_SECRET are required.'); process.exitCode = 2; return; }
  if (!config.treasuryAddress) { console.error('TREASURY_ADDRESS is not configured in PayCrypto.'); process.exitCode = 2; return; }
  const store = createStore();
  const jobs = await store.listSweepJobs();
  const job = jobs.find((j) => j.job_key === jobKey);
  if (!job) { console.error(`Sweep job '${jobKey}' not found. Create it in Admin first.`); process.exitCode = 2; return; }
  if (job.tx_hash) { console.error(`Sweep job '${jobKey}' already has tx_hash ${job.tx_hash} — refusing duplicate broadcast.`); process.exitCode = 2; return; }
  const result = await requestSigning({ signerUrl, apiSecret, body: { job_id: `sweep:${jobKey}:${index}`, kind: 'sweep', deposit_index: index, to: config.treasuryAddress, amount_base_units: parseUsdt(amount).toString(), contract: config.usdtContractForNetwork() } });
  console.log('Signer result:', result);
  if (result.dry_run) { console.log('Dry-run only: sweep job NOT marked completed. Set SIGNER_DRY_RUN=false on the signer to broadcast for real (testnet manual testing only).'); return; }
  await store.updateSweepJob(job.id, { status: 'completed', tx_hash: result.tx_hash });
  await store.logAudit({ actor_type: 'system', action: 'sweep.broadcast', entity_type: 'sweep_job', entity_id: job.id, details: { tx_hash: result.tx_hash, deposit_index: index } });
  console.log(`Sweep job '${jobKey}' completed on-chain: ${result.tx_hash}`);
}
if (require.main === module) main().catch((e) => { console.error('Sweep failed:', e.message); process.exitCode = 1; });
module.exports = { main };
