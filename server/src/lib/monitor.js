'use strict';
// Resumable, cron-compatible blockchain monitoring.
//  - Reads the last processed block from the DB checkpoint, never from memory.
//  - Scans in bounded ranges so one cron run cannot time out on shared hosting.
//  - Re-scans the last REORG_DEPTH blocks: a transfer that disappears from
//    its block is marked orphaned and is never credited.
//  - A transfer is credited EXACTLY ONCE: blockchain_transactions has a
//    UNIQUE(tx_hash, log_index) constraint and ledger_entries has a
//    UNIQUE(reference_key) constraint on payment:<tx-id>.
//  - Nothing is credited from a frontend claim or a customer-supplied hash:
//    only a Transfer log from the configured USDT contract, to a known
//    deposit address, with a successful receipt and >= CONFIRMATIONS.
//  - On RPC failure the checkpoint is NOT advanced, so the next run retries
//    the same range. This function is pure over a `provider`-like object in
//    tests and uses ethers in production (scripts/monitor.js).
const { parseTransferLog, isCanonicalTokenContract } = require('./blockchain');
const { classifyInvoice } = require('./ledger');
const { formatUsdt } = require('./money');

async function processTransfer(store, transfer, { tokenContract, confirmations, currentBlock, invoice }) {
  // transfer: {from,to,value,txHash,logIndex,blockNumber,blockHash,receiptStatus}
  if (!isCanonicalTokenContract(transfer.tokenContract || tokenContract, tokenContract)) {
    return { ignored: true, reason: 'token contract mismatch' };
  }
  const addressRow = await store.findAddressByValue(transfer.to);
  if (!addressRow) return { ignored: true, reason: 'unknown deposit address' };
  const inv = invoice || (addressRow.invoice_id ? await store.getInvoiceById(addressRow.invoice_id) : null);
  const conf = Math.max(0, currentBlock - transfer.blockNumber);
  const status = transfer.receiptStatus === false ? 'failed' : conf >= confirmations ? 'confirmed' : 'confirming';
  const { tx, duplicate } = await store.recordBlockchainTx({
    tx_hash: transfer.txHash, log_index: transfer.logIndex, block_number: transfer.blockNumber,
    block_hash: transfer.blockHash || null, from_address: transfer.from, to_address: transfer.to,
    token_contract: tokenContract, amount_base_units: transfer.value.toString(),
    invoice_id: inv?.id || null, merchant_id: addressRow.merchant_id, status, confirmations: conf,
  });
  if (duplicate) {
    // Still update confirmations/status on the existing row (idempotent).
    await store.updateTx(tx.id, { confirmations: conf, status });
  }
  let credited = false;
  if (status === 'confirmed' && inv && inv.status !== 'paid' && inv.status !== 'cancelled') {
    try {
      await store.addLedgerEntry({
        merchant_id: inv.merchant_id, invoice_id: inv.id, blockchain_tx_id: tx.id,
        entry_type: 'credit', amount_base_units: transfer.value.toString(),
        description: `USDT BEP20 payment ${transfer.txHash}`, reference_key: `payment:${tx.id}`,
      });
      credited = true;
    } catch (e) {
      if (e.code !== 'DUPLICATE') throw e; // duplicate credit prevented
    }
    // Recompute invoice status from ALL confirmed credits for that invoice.
    const all = await store.listTxs({ merchant_id: inv.merchant_id });
    const confirmedSum = all.filter((t) => t.invoice_id === inv.id && t.status === 'confirmed').reduce((a, t) => a + BigInt(t.amount_base_units), 0n);
    const confirmingSum = all.filter((t) => t.invoice_id === inv.id && t.status === 'confirming').reduce((a, t) => a + BigInt(t.amount_base_units), 0n);
    const newStatus = classifyInvoice({ expected: BigInt(inv.amount_base_units), receivedConfirmed: confirmedSum, receivedConfirming: confirmingSum, expiresAt: inv.expires_at });
    await store.updateInvoice(inv.id, { status: newStatus });
    if (credited) await store.logAudit({ actor_type: 'system', action: 'invoice.credited', entity_type: 'invoice', entity_id: inv.id, details: { tx_hash: transfer.txHash, amount_usdt: formatUsdt(transfer.value) } });
  }
  return { ignored: false, duplicate, credited, txId: tx.id, status };
}

module.exports = { processTransfer };
