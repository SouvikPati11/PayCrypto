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
  // PHASE 1 FIX (accounting): amount is the GROSS withdrawal. The fee is
  // taken FROM it (net = amount - fee), not charged ON TOP of it. The old
  // code required amount+fee <= balance but debited only amount on
  // confirmation, leaving the fee unaccounted for. Now debit(amount) on
  // confirmation is exactly the balance movement, and net is what is sent.
  const amount = parseUsdt(amountUsdt);
  const fee = parseUsdt(feeUsdt);
  const min = parseUsdt(minUsdt);
  const max = parseUsdt(maxUsdt);
  if (amount < min) return { ok: false, error: `Amount below minimum withdrawal (${minUsdt} USDT)` };
  if (amount > max) return { ok: false, error: `Amount above maximum withdrawal (${maxUsdt} USDT)` };
  if (amount <= fee) return { ok: false, error: 'Withdrawal amount must exceed the fee' };
  if (amount > BigInt(availableBaseUnits)) return { ok: false, error: 'Insufficient available balance' };
  return { ok: true, amount, fee, net: amount - fee };
}

module.exports = { deriveBalance, classifyInvoice, validateWithdrawal };
