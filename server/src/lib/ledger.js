'use strict';
// Pure ledger + invoice-status logic. No I/O, so it is fully unit-testable.
// Balances are ALWAYS derived: sum(credits) - sum(debits). There is no
// editable balance column anywhere in the schema.
const { parseUsdt } = require('./money');

function deriveBalance(entries) {
  return entries.reduce((acc, e) => {
    const amt = BigInt(String(e.amount_base_units));
    return e.entry_type === 'credit' ? acc + amt : acc - amt;
  }, 0n);
}

// expected / received are base-unit BigInts (or numeric strings).
// confirming = seen on chain but below the confirmation policy.
// Returns one of: pending, confirming, paid, underpaid, overpaid, expired, cancelled, failed
function classifyInvoice({ expected, receivedConfirmed = 0n, receivedConfirming = 0n, expiresAt, cancelled = false, failed = false }) {
  if (cancelled) return 'cancelled';
  if (failed) return 'failed';
  const exp = BigInt(expected);
  const conf = BigInt(receivedConfirmed);
  const confing = BigInt(receivedConfirming);
  if (conf === exp) return 'paid';
  if (conf > exp) return 'overpaid';
  if (conf > 0n && conf < exp) return 'underpaid';
  if (confing > 0n) return 'confirming';
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return 'expired';
  return 'pending';
}

function validateWithdrawal({ availableBaseUnits, amountUsdt, feeUsdt, minUsdt, maxUsdt }) {
  const amount = parseUsdt(amountUsdt);
  const fee = parseUsdt(feeUsdt);
  const min = parseUsdt(minUsdt);
  const max = parseUsdt(maxUsdt);
  if (amount < min) return { ok: false, error: `Amount below minimum withdrawal (${minUsdt} USDT)` };
  if (amount > max) return { ok: false, error: `Amount above maximum withdrawal (${maxUsdt} USDT)` };
  if (amount + fee > BigInt(availableBaseUnits)) return { ok: false, error: 'Insufficient available balance (including fee)' };
  return { ok: true, amount, fee, net: amount - fee };
}

module.exports = { deriveBalance, classifyInvoice, validateWithdrawal };
