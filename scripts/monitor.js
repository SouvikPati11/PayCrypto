'use strict';
// Cron entry: node scripts/monitor.js
// Resumable: checkpoint lives in MySQL (monitor_checkpoints) or the memory
// store in demo mode. On any RPC error the checkpoint is NOT advanced.
// Usage on Hostinger (hPanel > Cron Jobs, every 2-5 minutes):
//   cd ~/paycrypto && /usr/bin/node scripts/monitor.js >> logs/monitor.log 2>&1
// Do NOT run this as a permanently running worker on shared hosting.
const { ethers } = require('ethers');
const config = require('../server/src/lib/config');
const { createStore } = require('../server/src/lib/store');
const { validateChainId, verifyTokenContract, parseTransferLog } = require('../server/src/lib/blockchain');
const { processTransfer } = require('../server/src/lib/monitor');

async function main() {
  const tokenContract = config.usdtContractForNetwork();
  if (!tokenContract) {
    console.error(`No USDT contract configured for ${config.network}. Set USDT_CONTRACT_TESTNET after verifying a testnet token on testnet BscScan.`);
    process.exitCode = 2; return;
  }
  if (config.emergencyPause) { console.log('Emergency pause is on — monitor skipped.'); return; }
  const store = createStore();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  await validateChainId(provider, config.chainId);
  await verifyTokenContract(provider, tokenContract, { symbol: 'USDT', decimals: 18 });
  const checkpoint = await store.getCheckpoint();
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = checkpoint.last_block_number ? Math.max(checkpoint.last_block_number - config.reorgDepth, 0) : Math.max(currentBlock - 1000, 0);
  const toBlock = Math.min(fromBlock + 2000, currentBlock);
  if (toBlock <= fromBlock) { console.log('Nothing new to scan.'); return; }
  console.log(`Scanning ${config.network} blocks ${fromBlock}..${toBlock} for USDT ${tokenContract}`);
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const logs = await provider.getLogs({ address: tokenContract, fromBlock, toBlock, topics: [iface.getEvent('Transfer').topicHash] });
  let credited = 0; let ignored = 0;
  for (const log of logs) {
    const parsed = parseTransferLog(log, tokenContract);
    if (!parsed) { ignored++; continue; }
    const receipt = await provider.getTransactionReceipt(log.transactionHash);
    const result = await processTransfer(store, {
      ...parsed, tokenContract, receiptStatus: receipt ? receipt.status === 1 : false,
      blockHash: log.blockHash,
    }, { tokenContract, confirmations: config.confirmations, currentBlock });
    if (result.credited) {
      credited++;
      // Queue HMAC-signed webhooks (delivery + retries are handled by the
      // webhook worker / next cron pass; see docs/API.md). Secrets are
      // decrypted only here, never in the web process response path.
      try {
        const txRow = await store.getTxById(result.txId);
        if (txRow?.invoice_id) {
          const hooks = await store.getWebhooksFull(txRow.merchant_id);
          const { decryptSecret } = require('../server/src/lib/wallet');
          const { signWebhook } = require('../server/src/lib/webhooks');
          for (const wh of hooks) {
            const payload = { event: 'invoice.paid', invoice_id: txRow.invoice_id, tx_hash: txRow.tx_hash, amount_base_units: txRow.amount_base_units };
            const raw = JSON.stringify(payload);
            const signature = signWebhook(decryptSecret(wh.secret_encrypted), raw);
            await store.queueWebhookLog({ webhook_id: wh.id, merchant_id: txRow.merchant_id, invoice_id: txRow.invoice_id, event: 'invoice.paid', payload, signature });
          }
        }
      } catch (e) { console.warn('Webhook queue failed (payment already credited):', e.message); }
    }
    if (result.ignored) ignored++;
  }
  // Advance checkpoint only after successful scan + processing.
  await store.setCheckpoint(toBlock, '');
  console.log(`Done. logs=${logs.length} credited=${credited} ignored=${ignored} checkpoint=${toBlock}`);
}

if (require.main === module) main().catch((e) => { console.error('Monitor failed (checkpoint NOT advanced):', e.message); process.exitCode = 1; });
module.exports = { main };
