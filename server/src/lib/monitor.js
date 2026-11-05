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
// PHASE 1 changes:
//  - Expired invoices NEVER credit, even if payment arrives late. A late
//    payment is recorded for audit but does not move the ledger, and the
//    invoice is moved to expired. Previously a late confirmed payment
//    could mark an expired invoice paid.
//  - expirePendingInvoices() moves past-expiry pending invoices to expired
//    (called by scripts/monitor.js each run).
//  - reconcileOrphaned() marks confirming transfers that vanished from a
//    re-scanned range as orphaned, instead of leaving them confirming
//    forever.
const { parseTransferLog, isCanonicalTokenContract } = require('./blockchain');
const { classifyInvoice } = require('./ledger');
const { formatUsdt } = require('./money');

async function expirePendingInvoices(store, now = new Date()) {
  const invoices = await store.listInvoices({});
  let expired = 0;
  for (const inv of invoices) {
    if (inv.status === 'pending' && inv.expires_at && new Date(inv.expires_at).getTime() < now.getTime()) {
      await store.updateInvoice(inv.id, { status: 'expired' });
      expired++;
    }
  }
  return expired;
}

async function reconcileOrphaned(store, { scannedKeys, fromBlock, toBlock }) {
  // scannedKeys: Set of "txHash:logIndex" seen in this scan range.
  const txs = await store.listTxs({ status: 'confirming' });
  let orphaned = 0;
  for (const tx of txs) {
    const inRange = Number(tx.block_number) >= fromBlock && Number(tx.block_number) <= toBlock;
    if (inRange && !scannedKeys.has(`${tx.tx_hash}:${tx.log_index}`)) {
      await store.updateTx(tx.id, { status: 'orphaned' });
      orphaned++;
    }
  }
  return orphaned;
}

async function processTransfer(store, transfer, { tokenContract, confirmations, currentBlock, invoice }) {
  if (!isCanonicalTokenContract(transfer.tokenContract || tokenContract, tokenContract)) {
    return { ignored: true, reason: 'token contract mismatch' };
  }
  const addressRow = await store.findAddressByValue(transfer.to);
  if (!addressRow) return { ignored: true, reason: 'unknown deposit address' };
  const inv = invoice || (addressRow.invoice_id ? await store.getInvoiceById(addressRow.invoice_id) : null);
  const conf = Math.max(0, currentBlock - transfer.blockNumber);
  // PHASE 4 (fail-closed): only an explicit successful receipt counts.
  // A missing receipt (undefined) must never credit — previously it could.
  const receiptOk = transfer.receiptStatus === true;
  const status = !receiptOk ? 'failed' : conf >= confirmations ? 'confirmed' : 'confirming';
  const { tx, duplicate } = await store.recordBlockchainTx({
    tx_hash: transfer.txHash, log_index: transfer.logIndex, block_number: transfer.blockNumber,
    block_hash: transfer.blockHash || null, from_address: transfer.from, to_address: transfer.to,
    token_contract: tokenContract, amount_base_units: transfer.value.toString(),
    invoice_id: inv?.id || null, merchant_id: addressRow.merchant_id, status, confirmations: conf,
  });
  if (duplicate) {
    await store.updateTx(tx.id, { confirmations: conf, status });
  }
  // PHASE 1: expired invoices never credit, on first sight or on repeat.
  const isExpired = inv && inv.expires_at && new Date(inv.expires_at).getTime() < Date.now();
  if (isExpired && inv.status !== 'expired') {
    await store.updateInvoice(inv.id, { status: 'expired' });
  }
  if (isExpired) {
    return { ignored: true, credited: false, reason: 'invoice expired — payment recorded, not credited', txId: tx.id, status };
  }
  let credited = false;
  // PHASE 4: a second confirmed transfer to an already-paid invoice
  // (e.g. a customer sends twice) must still be credited to the
  // merchant ledger — the funds were received — but the invoice
  // stays 'paid' and is not reclassified. Cancelled/expired invoices
  // never credit (expired handled above).
  if (status === 'confirmed' && inv && inv.status !== 'cancelled') {
    try {
      await store.addLedgerEntry({
        merchant_id: inv.merchant_id, invoice_id: inv.id, blockchain_tx_id: tx.id,
        entry_type: 'credit', amount_base_units: transfer.value.toString(),
        description: `USDT BEP20 payment ${transfer.txHash}`, reference_key: `payment:${tx.id}`,
      });
      credited = true;
    } catch (e) {
      if (e.code !== 'DUPLICATE') throw e;
    }
    const all = await store.listTxs({ merchant_id: inv.merchant_id });
    const confirmedSum = all.filter((t) => t.invoice_id === inv.id && t.status === 'confirmed').reduce((a, t) => a + BigInt(t.amount_base_units), 0n);
    const confirmingSum = all.filter((t) => t.invoice_id === inv.id && t.status === 'confirming').reduce((a, t) => a + BigInt(t.amount_base_units), 0n);
    if (inv.status !== 'paid') {
      const newStatus = classifyInvoice({ expected: BigInt(inv.amount_base_units), receivedConfirmed: confirmedSum, receivedConfirming: confirmingSum, expiresAt: inv.expires_at });
      await store.updateInvoice(inv.id, { status: newStatus });
    }
    if (credited) await store.logAudit({ actor_type: 'system', action: 'invoice.credited', entity_type: 'invoice', entity_id: inv.id, details: { tx_hash: transfer.txHash, amount_usdt: formatUsdt(transfer.value) } });
  }
  return { ignored: false, duplicate, credited, txId: tx.id, status };
}

module.exports = { processTransfer, expirePendingInvoices, reconcileOrphaned };
