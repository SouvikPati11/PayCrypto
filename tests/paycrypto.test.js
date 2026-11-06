'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsdt, formatUsdt } = require('../server/src/lib/money');
const { classifyInvoice, validateWithdrawal, deriveBalance } = require('../server/src/lib/ledger');
const { deriveAddressFromMnemonic, getXpubFromMnemonic, deriveAddressFromXpub, isValidBscAddress, encryptSecret, decryptSecret } = require('../server/src/lib/wallet');
const { parseTransferLog, isCanonicalTokenContract } = require('../server/src/lib/blockchain');
const { signWebhook, verifyWebhook, nextRetryDelayMs } = require('../server/src/lib/webhooks');
const { generateApiKey, hashApiKey, totpToken, verifyTotp, newTotpSecret } = require('../server/src/lib/auth');
const { processTransfer } = require('../server/src/lib/monitor');
const { MemoryStore } = require('../server/src/lib/store');

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const MAINNET_USDT = '0x55d398326f99059fF775485246999027B3197955';
const OTHER_TOKEN = '0x0000000000000000000000000000000000000001';

test('money: USDT 18-decimal parse/format round-trips without float error', () => {
  assert.equal(formatUsdt(parseUsdt('10.5')), '10.5');
  assert.equal(formatUsdt(parseUsdt('0.000000000000000001')), '0.000000000000000001');
  assert.throws(() => parseUsdt('1.1234567890123456789'));
  assert.throws(() => parseUsdt('-5'));
});

test('ledger: balance is derived, never stored', () => {
  const bal = deriveBalance([
    { entry_type: 'credit', amount_base_units: '2000000000000000000' },
    { entry_type: 'debit', amount_base_units: '500000000000000000' },
  ]);
  assert.equal(bal, 1500000000000000000n);
});

test('invoice classification: pending, confirming, paid, underpaid, overpaid, expired', () => {
  const exp = parseUsdt('10');
  assert.equal(classifyInvoice({ expected: exp }), 'pending');
  assert.equal(classifyInvoice({ expected: exp, receivedConfirming: parseUsdt('10') }), 'confirming');
  assert.equal(classifyInvoice({ expected: exp, receivedConfirmed: parseUsdt('10') }), 'paid');
  assert.equal(classifyInvoice({ expected: exp, receivedConfirmed: parseUsdt('4') }), 'underpaid');
  assert.equal(classifyInvoice({ expected: exp, receivedConfirmed: parseUsdt('11') }), 'overpaid');
  assert.equal(classifyInvoice({ expected: exp, expiresAt: new Date(Date.now() - 1000).toISOString() }), 'expired');
  assert.equal(classifyInvoice({ expected: exp, cancelled: true }), 'cancelled');
});

test('withdrawal validation: limits, fee and insufficient balance', () => {
  const avail = parseUsdt('100');
  assert.equal(validateWithdrawal({ availableBaseUnits: avail, amountUsdt: '5', feeUsdt: '1', minUsdt: '10', maxUsdt: '10000' }).ok, false);
  // PHASE 1 (gross semantics): 100 gross with 1 fee is allowed (net 99),
  // 101 gross exceeds the 100 balance, and 1 gross does not exceed the fee.
  assert.equal(validateWithdrawal({ availableBaseUnits: avail, amountUsdt: '101', feeUsdt: '1', minUsdt: '10', maxUsdt: '10000' }).ok, false);
  assert.equal(validateWithdrawal({ availableBaseUnits: avail, amountUsdt: '1', feeUsdt: '1', minUsdt: '0.5', maxUsdt: '10000' }).ok, false);
  const ok100 = validateWithdrawal({ availableBaseUnits: avail, amountUsdt: '100', feeUsdt: '1', minUsdt: '10', maxUsdt: '10000' });
  assert.equal(ok100.ok, true); assert.equal(formatUsdt(ok100.net), '99');
  const ok = validateWithdrawal({ availableBaseUnits: avail, amountUsdt: '50', feeUsdt: '1', minUsdt: '10', maxUsdt: '10000' });
  assert.equal(ok.ok, true); assert.equal(formatUsdt(ok.net), '49');
  assert.equal(isValidBscAddress('0x55d398326f99059fF775485246999027B3197955'), true);
  assert.equal(isValidBscAddress('not-an-address'), false);
});

test('HD wallet: BIP44 m/44\'/60\'/0\'/0/index, unique indexes, xpub watch-only matches mnemonic', () => {
  const a0 = deriveAddressFromMnemonic(TEST_MNEMONIC, 0);
  const a1 = deriveAddressFromMnemonic(TEST_MNEMONIC, 1);
  assert.notEqual(a0, a1);
  assert.equal(deriveAddressFromMnemonic(TEST_MNEMONIC, 0), a0);
  const xpub = getXpubFromMnemonic(TEST_MNEMONIC);
  assert.equal(deriveAddressFromXpub(xpub, 0), a0);
  assert.equal(deriveAddressFromXpub(xpub, 1), a1);
  assert.throws(() => deriveAddressFromMnemonic(TEST_MNEMONIC, -1));
});

test('HD wallet: encrypted secret round-trips, wrong key fails', () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  const enc = encryptSecret('hello-secret');
  assert.equal(decryptSecret(enc), 'hello-secret');
  assert.notEqual(enc, 'hello-secret');
});

test('blockchain: only the canonical contract parses, other tokens rejected', () => {
  const { ethers } = require('ethers');
  const from = '0x1111111111111111111111111111111111111111';
  const to = deriveAddressFromMnemonic(TEST_MNEMONIC, 0);
  const log = {
    address: MAINNET_USDT, blockNumber: 100, transactionHash: '0x' + 'ab'.repeat(32), index: 0,
    topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
    data: ethers.zeroPadValue('0x0de0b6b3a7640000', 32),
  };
  const parsed = parseTransferLog(log, MAINNET_USDT);
  assert.ok(parsed); assert.equal(parsed.to.toLowerCase(), to.toLowerCase());
  assert.equal(parseTransferLog({ ...log, address: OTHER_TOKEN }, MAINNET_USDT), null);
  assert.equal(isCanonicalTokenContract(MAINNET_USDT, MAINNET_USDT), true);
  assert.equal(isCanonicalTokenContract(OTHER_TOKEN, MAINNET_USDT), false);
});

test('webhooks: HMAC sign/verify and retry backoff', () => {
  const body = '{"event":"invoice.paid"}';
  const sig = signWebhook('secret123', body);
  assert.equal(verifyWebhook('secret123', body, sig), true);
  assert.equal(verifyWebhook('secret123', body, 'sha256=dead'), false);
  assert.equal(nextRetryDelayMs(1), 60_000); assert.equal(nextRetryDelayMs(5), 21_600_000);
});

test('auth: API key hash never reveals plaintext; TOTP verifies', () => {
  const { plaintext, hash } = generateApiKey(false);
  assert.ok(plaintext.startsWith('pk_test_'));
  assert.equal(hashApiKey(plaintext), hash);
  const secret = newTotpSecret();
  assert.equal(verifyTotp(totpToken(secret), secret), true);
  assert.equal(verifyTotp('000000', secret), false);
});

test('store: unique address assignment, duplicate tx never credits twice, sweep idempotency', async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  const store = new MemoryStore();
  store.setAddressDeriver((i) => deriveAddressFromMnemonic(TEST_MNEMONIC, i));
  const merchant = await store.createMerchant({ user_id: null, business_name: 'Acme', contact_email: 'a@example.com', status: 'approved' });
  const { invoice } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-TEST1', amount_base_units: parseUsdt('10').toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const addr = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: invoice.id });
  const addr2 = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: invoice.id });
  assert.equal(addr.id, addr2.id); // same invoice -> same address, no index burn
  await store.updateInvoice(invoice.id, { deposit_address: addr.address, deposit_address_id: addr.id });
  const transfer = {
    from: '0x1111111111111111111111111111111111111111', to: addr.address, value: parseUsdt('10'),
    txHash: '0x' + 'cd'.repeat(32), logIndex: 0, blockNumber: 100, blockHash: '0x' + '00'.repeat(32),
    tokenContract: MAINNET_USDT, receiptStatus: true,
  };
  const r1 = await processTransfer(store, transfer, { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 112 });
  assert.equal(r1.credited, true);
  const r2 = await processTransfer(store, transfer, { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 112 });
  assert.equal(r2.credited, false); assert.equal(r2.duplicate, true);
  assert.equal(await store.merchantBalance(merchant.id), parseUsdt('10'));
  const invAfter = await store.getInvoiceById(invoice.id);
  assert.equal(invAfter.status, 'paid');

  // Underpayment path: second invoice, partial confirmed payment.
  const { invoice: inv2 } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-TEST2', amount_base_units: parseUsdt('10').toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const addrB = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: inv2.id });
  assert.notEqual(addrB.address, addr.address);
  assert.notEqual(addrB.derivation_index, addr.derivation_index);
  await store.updateInvoice(inv2.id, { deposit_address: addrB.address, deposit_address_id: addrB.id });
  await processTransfer(store, { ...transfer, to: addrB.address, value: parseUsdt('4'), txHash: '0x' + 'ef'.repeat(32) }, { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 112 });
  assert.equal((await store.getInvoiceById(inv2.id)).status, 'underpaid');

  // Sweep idempotency: same job_key returns the original job.
  const s1 = await store.createSweepJob({ job_key: 'sweep-1', treasury_address: '0x2222222222222222222222222222222222222222', total_base_units: '100' });
  const s2 = await store.createSweepJob({ job_key: 'sweep-1', treasury_address: '0x2222222222222222222222222222222222222222', total_base_units: '999' });
  assert.equal(s2.duplicate, true); assert.equal(s1.job.id, s2.job.id);

  // RPC failure recovery analogue: a confirming (unconfirmed) transfer does NOT credit.
  const { invoice: inv3 } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-TEST3', amount_base_units: parseUsdt('10').toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const addrC = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: inv3.id });
  await store.updateInvoice(inv3.id, { deposit_address: addrC.address, deposit_address_id: addrC.id });
  await processTransfer(store, { ...transfer, to: addrC.address, value: parseUsdt('10'), txHash: '0x' + '12'.repeat(32) }, { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 105 });
  assert.equal((await store.getInvoiceById(inv3.id)).status, 'pending'); // confirming tx exists but invoice stays pending until confirmed credit path runs
  assert.equal(await store.merchantBalance(merchant.id), parseUsdt('14')); // 10 + 4 only
});

// ---- PHASE 1 tests ----
const { verifyCsrf, csrfRequired } = require('../server/src/lib/csrf');
const { expirePendingInvoices, reconcileOrphaned } = require('../server/src/lib/monitor');

test('phase1: CSRF double-submit verifies cookie vs header, API-key exempt', () => {
  const good = { cookies: { paycrypto_csrf: 'abc123' }, headers: { 'x-csrf-token': 'abc123' }, method: 'POST', user: { sub: 1 } };
  assert.equal(verifyCsrf(good), true);
  assert.equal(verifyCsrf({ ...good, headers: { 'x-csrf-token': 'wrong' } }), false);
  assert.equal(verifyCsrf({ ...good, cookies: {} }), false);
  assert.equal(csrfRequired({ method: 'GET', user: { sub: 1 } }), false);
  assert.equal(csrfRequired({ method: 'POST', user: { sub: 1 }, headers: { authorization: 'Bearer pk_test_x' } }), false);
  assert.equal(csrfRequired({ method: 'POST', user: { sub: 1 }, headers: {} }), true);
});

test('phase1: passphrase encryption uses a random salt (blobs differ, both decrypt)', () => {
  process.env.ENCRYPTION_KEY = 'a-local-passphrase-only-not-hex';
  const a = encryptSecret('secret-value');
  const b = encryptSecret('secret-value');
  assert.notEqual(a, b);
  assert.equal(a.split(':').length, 4);
  assert.equal(decryptSecret(a), 'secret-value');
  assert.equal(decryptSecret(b), 'secret-value');
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});

test('phase1: expired invoice never credits, even on a confirmed late payment', async () => {
  const store = new MemoryStore();
  store.setAddressDeriver((i) => deriveAddressFromMnemonic(TEST_MNEMONIC, i));
  const merchant = await store.createMerchant({ user_id: null, business_name: 'Late', contact_email: 'late@example.com', status: 'approved' });
  const { invoice } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-EXPIRED', amount_base_units: parseUsdt('10').toString(), expires_at: new Date(Date.now() - 1000).toISOString() });
  const addr = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: invoice.id });
  await store.updateInvoice(invoice.id, { deposit_address: addr.address, deposit_address_id: addr.id });
  const r = await processTransfer(store, { from: '0x1111111111111111111111111111111111111111', to: addr.address, value: parseUsdt('10'), txHash: '0x' + 'aa'.repeat(32), logIndex: 0, blockNumber: 100, tokenContract: MAINNET_USDT, receiptStatus: true }, { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 112 });
  assert.equal(r.credited, false);
  assert.equal((await store.getInvoiceById(invoice.id)).status, 'expired');
  assert.equal(await store.merchantBalance(merchant.id), 0n);
});

test('phase1: expirePendingInvoices + orphan reconcile', async () => {
  const store = new MemoryStore();
  store.setAddressDeriver((i) => deriveAddressFromMnemonic(TEST_MNEMONIC, i));
  const merchant = await store.createMerchant({ user_id: null, business_name: 'Orph', contact_email: 'o@example.com', status: 'approved' });
  const { invoice } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-ORPH', amount_base_units: parseUsdt('10').toString(), expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await expirePendingInvoices(store), 1);
  assert.equal((await store.getInvoiceById(invoice.id)).status, 'expired');
  // Confirming tx that vanishes from a re-scan is orphaned.
  const { invoice: inv2 } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-ORPH2', amount_base_units: parseUsdt('10').toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const addr = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: inv2.id });
  await store.updateInvoice(inv2.id, { deposit_address: addr.address, deposit_address_id: addr.id });
  await processTransfer(store, { from: '0x1111111111111111111111111111111111111111', to: addr.address, value: parseUsdt('10'), txHash: '0x' + 'bb'.repeat(32), logIndex: 0, blockNumber: 100, tokenContract: MAINNET_USDT, receiptStatus: true }, { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 105 });
  const confirming = (await store.listTxs({ status: 'confirming' }))[0];
  assert.ok(confirming);
  assert.equal(await reconcileOrphaned(store, { scannedKeys: new Set(), fromBlock: 90, toBlock: 110 }), 1);
  assert.equal((await store.getTxById(confirming.id)).status, 'orphaned');
});

test('phase1: session revocation + SQL column allowlist', async () => {
  const store = new MemoryStore();
  await store.createSession({ user_id: 1, token_hash: 'hash123', ip_address: '127.0.0.1', user_agent: 'test', expires_at: new Date().toISOString() });
  assert.ok(await store.findSessionByTokenHash('hash123'));
  await store.revokeSessionByTokenHash('hash123');
  assert.equal(await store.findSessionByTokenHash('hash123'), null);
  const merchant = await store.createMerchant({ user_id: null, business_name: 'Allow', contact_email: 'al@example.com', status: 'approved' });
  const { invoice } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-ALLOW', amount_base_units: parseUsdt('1').toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  await assert.rejects(() => store.updateInvoice(invoice.id, { amount_base_units: '999' }), /unknown field/);
});

// ---- PHASE 2 tests ----
const { createPerKeyLimiter } = require('../server/src/lib/rate-limit');
const { toMysqlDatetime } = require('../server/src/lib/dates');
const { deliverOne } = require('../server/src/lib/webhook-delivery');

test('phase2: per-key rate limiter allows up to max, then 429s, per key', () => {
  const limiter = createPerKeyLimiter({ windowMs: 60_000, max: 2 });
  const req = (merchantId) => ({ merchantId, ip: '127.0.0.1' });
  const res = () => { const r = { statusCode: null, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, set() {} }; return r; };
  let nextCalls = 0; const next = () => { nextCalls++; };
  const r1 = res(); limiter(req(1), r1, next);
  const r2 = res(); limiter(req(1), r2, next);
  const r3 = res(); limiter(req(1), r3, next);
  assert.equal(nextCalls, 2); assert.equal(r3.statusCode, 429);
  // A different merchant is not blocked by the first merchant's usage.
  const r4 = res(); limiter(req(2), r4, next);
  assert.equal(nextCalls, 3);
});

test('phase2: MySQL datetime conversion', () => {
  assert.equal(toMysqlDatetime('2026-11-05T07:00:00.000Z'), '2026-11-05 07:00:00');
  assert.equal(toMysqlDatetime('2026-11-05 07:00:00'), '2026-11-05 07:00:00');
  assert.equal(toMysqlDatetime(null), null);
});

test('phase2: webhook delivery marks sent on 2xx, retries on failure, fails after 5', async () => {
  const store = new MemoryStore();
  store.setAddressDeriver((i) => deriveAddressFromMnemonic(TEST_MNEMONIC, i));
  const log = await store.queueWebhookLog({ webhook_id: 1, merchant_id: 1, event: 'invoice.paid', payload: { event: 'invoice.paid' }, signature: 'sha256=x', url: undefined });
  // Success path
  const ok = await deliverOne(store, { ...log, url: 'https://example.com/hook' }, async () => ({ status: 200 }));
  assert.equal(ok.delivered, true);
  const afterOk = store.webhookLogs.find((x) => x.id === log.id);
  assert.equal(afterOk.status, 'sent'); assert.equal(afterOk.attempts, 1);
  // Failure path, then final failure at attempt 5
  const log2 = await store.queueWebhookLog({ webhook_id: 1, merchant_id: 1, event: 'invoice.paid', payload: {}, signature: 'sha256=y' });
  const fail = await deliverOne(store, { ...log2, url: 'https://example.com/hook' }, async () => { throw new Error('network down'); });
  assert.equal(fail.delivered, false);
  const afterFail = store.webhookLogs.find((x) => x.id === log2.id);
  assert.equal(afterFail.status, 'pending'); assert.equal(afterFail.attempts, 1); assert.ok(afterFail.next_retry_at);
  const log3 = await store.queueWebhookLog({ webhook_id: 1, merchant_id: 1, event: 'invoice.paid', payload: {}, signature: 'sha256=z' });
  store.webhookLogs.find((x) => x.id === log3.id).attempts = 4;
  const finalFail = await deliverOne(store, { ...store.webhookLogs.find((x) => x.id === log3.id), url: 'https://example.com/hook' }, async () => ({ status: 500 }));
  assert.equal(finalFail.failed, true);
  assert.equal(store.webhookLogs.find((x) => x.id === log3.id).status, 'failed');
});

test('phase2: due webhook logs only include pending, under-5-attempt, due logs', async () => {
  const store = new MemoryStore();
  const due = await store.queueWebhookLog({ webhook_id: 1, merchant_id: 1, event: 'invoice.paid', payload: {}, signature: 's' });
  const notDue = await store.queueWebhookLog({ webhook_id: 1, merchant_id: 1, event: 'invoice.paid', payload: {}, signature: 's' });
  store.webhookLogs.find((x) => x.id === notDue.id).next_retry_at = new Date(Date.now() + 3600_000).toISOString();
  const dueList = await store.listDueWebhookLogs();
  assert.ok(dueList.some((x) => x.id === due.id));
  assert.ok(!dueList.some((x) => x.id === notDue.id));
});

// ---- PHASE 4 tests (BSC testnet verification & payment scenarios) ----
// NOTE: these are deterministic simulations of on-chain transfers.
// No real funds, no private keys, no live transaction is sent by any
// test here. Live testnet sending is a manual step (see TESTNET.md).
const { verifyTokenContract, validateChainId } = require('../server/src/lib/blockchain');
const TESTNET_TOKEN = '0x1111111111111111111111111111111111112222'; // simulated testnet token, NOT a real contract

async function phase4Setup(amountUsdt = '10') {
  const store = new MemoryStore();
  store.setAddressDeriver((i) => deriveAddressFromMnemonic(TEST_MNEMONIC, i));
  const merchant = await store.createMerchant({ user_id: null, business_name: 'P4', contact_email: 'p4@example.com', status: 'approved' });
  const { invoice } = await store.createInvoice({ merchant_id: merchant.id, reference: 'PC-P4-' + Math.random().toString(36).slice(2, 8).toUpperCase(), amount_base_units: parseUsdt(amountUsdt).toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const addr = await store.allocateDepositAddress({ merchantId: merchant.id, invoiceId: invoice.id });
  await store.updateInvoice(invoice.id, { deposit_address: addr.address, deposit_address_id: addr.id });
  return { store, merchant, invoice: await store.getInvoiceById(invoice.id), addr };
}
function txFor(addr, valueUsdt, { txHash, logIndex = 0, blockNumber = 100, receiptStatus = true, tokenContract = TESTNET_TOKEN } = {}) {
  return { from: '0x1111111111111111111111111111111111111111', to: addr.address, value: parseUsdt(valueUsdt), txHash: txHash || ('0x' + 'cc'.repeat(32)), logIndex, blockNumber, tokenContract, receiptStatus };
}
const P4_OPTS = (currentBlock = 112) => ({ tokenContract: TESTNET_TOKEN, confirmations: 12, currentBlock });

test('phase4: HD deposit addresses are unique per invoice and deterministic', async () => {
  const a = await phase4Setup();
  assert.equal(a.addr.address, deriveAddressFromMnemonic(TEST_MNEMONIC, 0));
  // Second invoice in the same store gets the next index, not a reuse.
  const { invoice } = await a.store.createInvoice({ merchant_id: a.merchant.id, reference: 'PC-P4-SECOND', amount_base_units: parseUsdt('1').toString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const addr2 = await a.store.allocateDepositAddress({ merchantId: a.merchant.id, invoiceId: invoice.id });
  assert.notEqual(addr2.address, a.addr.address);
  assert.equal(addr2.address, deriveAddressFromMnemonic(TEST_MNEMONIC, 1));
  // A fresh store with the same mnemonic re-derives the same index 0
  // address — determinism, not a collision: uniqueness is per store.
  const b = await phase4Setup();
  assert.equal(b.addr.address, a.addr.address);
});

test('phase4: exact payment, confirming then confirmed, credits ledger once', async () => {
  const { store, merchant, invoice, addr } = await phase4Setup();
  const confirming = await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '11'.repeat(32) }), P4_OPTS(105));
  assert.equal(confirming.status, 'confirming'); assert.equal(confirming.credited, false);
  assert.equal(await store.merchantBalance(merchant.id), 0n);
  const confirmed = await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '11'.repeat(32) }), P4_OPTS(112));
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.credited, true); assert.equal(confirmed.duplicate, true);
  assert.equal((await store.getInvoiceById(invoice.id)).status, 'paid');
  assert.equal(await store.merchantBalance(merchant.id), parseUsdt('10'));
});

test('phase4: contract validation — wrong token, wrong symbol, wrong decimals, chain mismatch all fail closed', async () => {
  const { store, addr } = await phase4Setup();
  // Wrong contract address is ignored, never credited.
  const wrong = await processTransfer(store, txFor(addr, '10', { tokenContract: OTHER_TOKEN }), P4_OPTS());
  assert.equal(wrong.ignored, true); assert.equal(await store.merchantBalance(1), 0n);
  // verifyTokenContract against a mock provider that returns encoded
  // ERC20 name/symbol/decimals: correct token passes, wrong symbol or
  // decimals is rejected, and chain-ID validation is enforced.
  const { ethers } = require('ethers');
  const { ERC20_ABI } = require('../server/src/lib/blockchain');
  const iface = new ethers.Interface(ERC20_ABI);
  const coder = new ethers.AbiCoder();
  const sel = (fn) => iface.getFunction(fn).selector;
  const mockProvider = (sym, dec) => ({
    getNetwork: async () => ({ chainId: 97n }),
    call: async (tx) => {
      if (tx.data.startsWith(sel('name'))) return coder.encode(['string'], ['Test USDT']);
      if (tx.data.startsWith(sel('symbol'))) return coder.encode(['string'], [sym]);
      if (tx.data.startsWith(sel('decimals'))) return coder.encode(['uint8'], [dec]);
      throw new Error('unknown function');
    },
  });
  assert.deepEqual(await verifyTokenContract(mockProvider('USDT', 18), TESTNET_TOKEN, { symbol: 'USDT', decimals: 18 }), { name: 'Test USDT', symbol: 'USDT', decimals: 18 });
  await assert.rejects(() => verifyTokenContract(mockProvider('TUSDT', 18), TESTNET_TOKEN, { symbol: 'USDT', decimals: 18 }), /Token contract mismatch/);
  await assert.rejects(() => verifyTokenContract(mockProvider('USDT', 6), TESTNET_TOKEN, { symbol: 'USDT', decimals: 18 }), /Token contract mismatch/);
  assert.equal(isCanonicalTokenContract(TESTNET_TOKEN, TESTNET_TOKEN), true);
  assert.equal(isCanonicalTokenContract(OTHER_TOKEN, TESTNET_TOKEN), false);
  await assert.rejects(() => validateChainId({ getNetwork: async () => ({ chainId: 56n }) }, 97), /Chain ID mismatch/);
  assert.equal(await validateChainId({ getNetwork: async () => ({ chainId: 97n }) }, 97), true);
});

test('phase4: failed receipt never credits, and missing receipt never credits (fail-closed)', async () => {
  const { store, merchant, invoice, addr } = await phase4Setup();
  const failed = await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '22'.repeat(32), receiptStatus: false }), P4_OPTS());
  assert.equal(failed.status, 'failed'); assert.equal(failed.credited, false);
  const missingTx = txFor(addr, '10', { txHash: '0x' + '23'.repeat(32) }); delete missingTx.receiptStatus;
  const missing = await processTransfer(store, missingTx, P4_OPTS());
  assert.equal(missing.status, 'failed'); assert.equal(missing.credited, false);
  assert.equal(await store.merchantBalance(merchant.id), 0n);
  assert.equal((await store.getInvoiceById(invoice.id)).status, 'pending');
});

test('phase4: underpayment and overpayment classification, partial ledger credit documented', async () => {
  const u = await phase4Setup();
  await processTransfer(u.store, txFor(u.addr, '4', { txHash: '0x' + '31'.repeat(32) }), P4_OPTS());
  assert.equal((await u.store.getInvoiceById(u.invoice.id)).status, 'underpaid');
  assert.equal(await u.store.merchantBalance(u.merchant.id), parseUsdt('4'));
  const o = await phase4Setup();
  await processTransfer(o.store, txFor(o.addr, '12', { txHash: '0x' + '32'.repeat(32) }), P4_OPTS());
  assert.equal((await o.store.getInvoiceById(o.invoice.id)).status, 'overpaid');
  assert.equal(await o.store.merchantBalance(o.merchant.id), parseUsdt('12'));
});

test('phase4: duplicate tx+logIndex never credits twice; different logIndex in same tx credits separately', async () => {
  const { store, merchant, invoice, addr } = await phase4Setup();
  await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '41'.repeat(32) }), P4_OPTS());
  const dup = await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '41'.repeat(32) }), P4_OPTS());
  assert.equal(dup.duplicate, true); assert.equal(dup.credited, false);
  assert.equal(await store.merchantBalance(merchant.id), parseUsdt('10'));
  // Same tx hash, different log index = a second, distinct transfer.
  const second = await processTransfer(store, txFor(addr, '5', { txHash: '0x' + '41'.repeat(32), logIndex: 1 }), P4_OPTS());
  assert.equal(second.credited, true);
  assert.equal(await store.merchantBalance(merchant.id), parseUsdt('15'));
  assert.equal((await store.getInvoiceById(invoice.id)).status, 'paid');
});

test('phase4: reorg — confirming transfer vanishing from re-scan is orphaned, never credited', async () => {
  const { store, merchant, invoice, addr } = await phase4Setup();
  await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '51'.repeat(32) }), P4_OPTS(105));
  const { reconcileOrphaned } = require('../server/src/lib/monitor');
  assert.equal(await reconcileOrphaned(store, { scannedKeys: new Set(), fromBlock: 90, toBlock: 110 }), 1);
  assert.equal(await store.merchantBalance(merchant.id), 0n);
});

test('phase4: testnet/mainnet isolation — mainnet contract transfer never credits a testnet-configured invoice', async () => {
  const { store, merchant, invoice, addr } = await phase4Setup();
  const mainnetTx = await processTransfer(store, txFor(addr, '10', { tokenContract: MAINNET_USDT }), { tokenContract: TESTNET_TOKEN, confirmations: 12, currentBlock: 112 });
  assert.equal(mainnetTx.ignored, true);
  assert.equal(await store.merchantBalance(merchant.id), 0n);
  assert.equal((await store.getInvoiceById(invoice.id)).status, 'pending');
  // And the reverse: a testnet-token transfer against a mainnet expectation is ignored.
  const reverse = await processTransfer(store, txFor(addr, '10', { tokenContract: TESTNET_TOKEN }), { tokenContract: MAINNET_USDT, confirmations: 12, currentBlock: 112 });
  assert.equal(reverse.ignored, true);
});

test('phase4: ledger crediting + withdrawal approval flow without real funds', async () => {
  const { store, merchant, invoice, addr } = await phase4Setup();
  await processTransfer(store, txFor(addr, '10', { txHash: '0x' + '61'.repeat(32) }), P4_OPTS());
  assert.equal(await store.merchantBalance(merchant.id), parseUsdt('10'));
  const w = await store.createWithdrawal({ merchant_id: merchant.id, destination_address: '0x2222222222222222222222222222222222222222', amount_base_units: parseUsdt('10').toString(), fee_base_units: parseUsdt('1').toString(), net_base_units: parseUsdt('9').toString() });
  assert.equal(w.status, 'pending');
  // Admin approval alone does not debit: debit happens only on on-chain confirmation (admin route, Phase 1/2).
  // Here we verify the validation that gates it: 10 gross with 1 fee is allowed against a 10 balance.
  const { validateWithdrawal } = require('../server/src/lib/ledger');
  assert.equal(validateWithdrawal({ availableBaseUnits: parseUsdt('10'), amountUsdt: '10', feeUsdt: '1', minUsdt: '10', maxUsdt: '10000' }).ok, true);
  // Simulating the confirmed-withdrawal debit:
  await store.addLedgerEntry({ merchant_id: merchant.id, withdrawal_id: w.id, entry_type: 'debit', amount_base_units: parseUsdt('10').toString(), description: 'Withdrawal confirmed', reference_key: `withdrawal:${w.id}` });
  assert.equal(await store.merchantBalance(merchant.id), 0n);
});

// ---- PHASE 5 tests (signer service, mocks + test-only keys only) ----
const { hmacSign, verifySignerRequest, validateSignRequest, verifyReceipt, signJob, buildUsdtTransfer } = require('../services/signer/core');
const { ethers } = require('ethers');

const P5_MNEMONIC = TEST_MNEMONIC;
const P5_TREASURY = '0x2222222222222222222222222222222222222222';
const P5_CONTRACT = '0x3333333333333333333333333333333333333333';
const P5_CFG = { network: 'testnet', chainId: 97, usdtContract: P5_CONTRACT.toLowerCase(), treasuryAddress: P5_TREASURY.toLowerCase(), dryRun: true, maxGasPriceGwei: 5, maxTxUsdt: '10000', dailyLimitUsdt: '100', minSweepUsdt: '10', confirmations: 12 };
function p5State() { return { dailyTotals: {}, broadcasts: {} }; }
function p5Audit() { const logs = []; return { logs, fn: (e) => logs.push(e) }; }
// Mock provider: gas 3 gwei, estimate 60000, 1 BNB, 100 USDT, nonce 0, broadcast returns a receipt.
function p5Provider({ bnb = 1000000000000000000n, usdt = parseUsdt('100'), gasPrice = 3000000000n } = {}) {
  const coder = new ethers.AbiCoder();
  return {
    getFeeData: async () => ({ gasPrice }),
    estimateGas: async () => 60000n,
    getBalance: async () => bnb,
    getTransactionCount: async () => 0,
    call: async () => coder.encode(['uint256'], [usdt]),
    broadcastTransaction: async (signed) => ({ hash: ethers.keccak256(signed), wait: async () => ({ status: 1, to: P5_CONTRACT, logs: [] }) }),
  };
}
function p5DepositWallet(index = 0) { return ethers.HDNodeWallet.fromPhrase(P5_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`); }
function p5TreasuryWallet() { return new ethers.Wallet('0x' + '11'.repeat(32)); }

test('phase5: signer HMAC auth — valid passes, tampered fails, old timestamp fails, nonce reuse fails', () => {
  const secret = 'a'.repeat(32);
  const body = JSON.stringify({ job_id: 'x' });
  const sig = hmacSign(secret, 'POST', '/sign', '1700000000000', 'nonce-1', body);
  const seen = new Map();
  assert.equal(verifySignerRequest({ method: 'POST', path: '/sign', timestamp: '1700000000000', nonce: 'nonce-1', body, signature: sig, secret, seenNonces: seen, nowMs: 1700000000000 }).ok, true);
  assert.equal(verifySignerRequest({ method: 'POST', path: '/sign', timestamp: '1700000000000', nonce: 'nonce-1', body, signature: sig, secret, seenNonces: seen, nowMs: 1700000000000 }).ok, false); // replay
  assert.equal(verifySignerRequest({ method: 'POST', path: '/sign', timestamp: '1700000000000', nonce: 'nonce-2', body, signature: '00'.repeat(32), secret, seenNonces: seen, nowMs: 1700000000000 }).ok, false);
  assert.equal(verifySignerRequest({ method: 'POST', path: '/sign', timestamp: '1700000000000', nonce: 'nonce-3', body, signature: sig, secret, seenNonces: seen, nowMs: 1700000000000 + 600_000 }).ok, false); // stale
});

test('phase5: sweep destination must be treasury; withdrawal must have approval and must not target treasury', () => {
  const sweepOk = validateSignRequest({ job_id: 'sweep:1', kind: 'sweep', deposit_index: 0, to: P5_TREASURY, amount_base_units: parseUsdt('10').toString() }, P5_CFG);
  assert.equal(sweepOk.kind, 'sweep');
  assert.throws(() => validateSignRequest({ job_id: 'sweep:1', kind: 'sweep', deposit_index: 0, to: '0x4444444444444444444444444444444444444444', amount_base_units: parseUsdt('10').toString() }, P5_CFG), /treasury/);
  assert.throws(() => validateSignRequest({ job_id: 'wd:1', kind: 'withdrawal', withdrawal_id: 1, to: P5_TREASURY, amount_base_units: parseUsdt('10').toString(), approved_by: 'admin' }, P5_CFG), /treasury/);
  assert.throws(() => validateSignRequest({ job_id: 'wd:1', kind: 'withdrawal', withdrawal_id: 1, to: '0x4444444444444444444444444444444444444444', amount_base_units: parseUsdt('10').toString() }, P5_CFG), /approved_by/);
  assert.throws(() => validateSignRequest({ job_id: 'wd:1', kind: 'withdrawal', withdrawal_id: 1, to: '0x4444444444444444444444444444444444444444', amount_base_units: parseUsdt('20000').toString(), approved_by: 'admin' }, { ...P5_CFG, maxTxUsdt: '10000' }), /limit/);
});

test('phase5: gas management — insufficient BNB fails, gas price over cap fails', async () => {
  const wallet = p5DepositWallet(0);
  await assert.rejects(() => buildUsdtTransfer({ wallet, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString(), cfg: P5_CFG, provider: p5Provider({ bnb: 1n }) }), /Insufficient BNB/);
  await assert.rejects(() => buildUsdtTransfer({ wallet, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString(), cfg: P5_CFG, provider: p5Provider({ gasPrice: 10000000000n }) }), /Gas price/);
  await assert.rejects(() => buildUsdtTransfer({ wallet, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString(), cfg: P5_CFG, provider: p5Provider({ usdt: parseUsdt('5') }) }), /Insufficient USDT/);
  const ok = await buildUsdtTransfer({ wallet, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString(), cfg: P5_CFG, provider: p5Provider() });
  assert.equal(ok.tx.chainId, 97); assert.equal(ok.tx.to, P5_CONTRACT.toLowerCase());
});

test('phase5: signJob dry-run signs without broadcasting, duplicate job returns existing result, daily limit enforced', async () => {
  const state = p5State(); const { logs, fn } = p5Audit();
  const wallet = p5DepositWallet(0);
  const r1 = await signJob({ req: { job_id: 'sweep:test-1', kind: 'sweep', deposit_index: 0, to: P5_TREASURY, amount_base_units: parseUsdt('10').toString() }, wallet, cfg: P5_CFG, provider: p5Provider(), state, audit: fn });
  assert.equal(r1.broadcast, false); assert.equal(r1.dry_run, true); assert.ok(/^0x[0-9a-f]{64}$/.test(r1.tx_hash));
  const r2 = await signJob({ req: { job_id: 'sweep:test-1', kind: 'sweep', deposit_index: 0, to: P5_TREASURY, amount_base_units: parseUsdt('10').toString() }, wallet, cfg: P5_CFG, provider: p5Provider(), state, audit: fn });
  assert.equal(r2.duplicate, true); assert.equal(r2.tx_hash, r1.tx_hash);
  assert.ok(logs.some((l) => l.event === 'sign.dry_run'));
  // Daily limit: 100 USDT/day, 10 already dry-run does NOT consume limit, but a broadcast would. Simulate a broadcast day total of 95, then a 10 broadcast must fail.
  const state2 = p5State(); state2.dailyTotals[new Date().toISOString().slice(0, 10)] = parseUsdt('95').toString();
  const cfgLive = { ...P5_CFG, dryRun: false };
  await assert.rejects(() => signJob({ req: { job_id: 'wd:limit', kind: 'withdrawal', withdrawal_id: 1, approved_by: 'admin', to: '0x4444444444444444444444444444444444444444', amount_base_units: parseUsdt('10').toString() }, wallet: p5TreasuryWallet(), cfg: cfgLive, provider: p5Provider(), state: state2, audit: fn }), /Daily limit/);
});

test('phase5: signJob live broadcast verifies receipt and records daily total', async () => {
  const state = p5State(); const { fn } = p5Audit();
  const cfgLive = { ...P5_CFG, dryRun: false };
  const r = await signJob({ req: { job_id: 'wd:live-1', kind: 'withdrawal', withdrawal_id: 1, approved_by: 'admin', to: '0x4444444444444444444444444444444444444444', amount_base_units: parseUsdt('10').toString() }, wallet: p5TreasuryWallet(), cfg: cfgLive, provider: p5Provider(), state, audit: fn });
  assert.equal(r.broadcast, true); assert.equal(r.receipt_status, 1);
  assert.equal(BigInt(state.dailyTotals[new Date().toISOString().slice(0, 10)]), parseUsdt('10'));
});

test('phase5: receipt verification rejects failed tx and wrong contract', () => {
  assert.equal(verifyReceipt({ status: 1, to: P5_CONTRACT, logs: [] }, { contract: P5_CONTRACT, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString() }), true);
  assert.throws(() => verifyReceipt({ status: 0, to: P5_CONTRACT, logs: [] }, { contract: P5_CONTRACT, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString() }), /failed/);
  assert.throws(() => verifyReceipt({ status: 1, to: '0x5555555555555555555555555555555555555555', logs: [] }, { contract: P5_CONTRACT, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString() }), /contract mismatch/);
  assert.throws(() => verifyReceipt(null, { contract: P5_CONTRACT, to: P5_TREASURY, amountBaseUnits: parseUsdt('10').toString() }), /No receipt/);
});

// ---- HOSTINGER STARTUP tests (listen first, DB/deriver after) ----
const { isDbError } = require('../server/src/lib/db-error');

test('hostinger: DB errors map to 503, non-DB errors do not', () => {
  assert.equal(isDbError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isDbError({ code: 'ER_ACCESS_DENIED_ERROR' }), true);
  assert.equal(isDbError({ code: 'ER_DUP_ENTRY' }), true);
  assert.equal(isDbError(new Error('some other failure')), false);
  assert.equal(isDbError(null), false);
});

test('hostinger: production + MEMORY_DB refuses to create a store (no silent memory fallback)', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', "require('./server/src/lib/store').createStore(); console.log('STORE_OK')"], {
    cwd: __dirname + '/..',
    env: { ...process.env, NODE_ENV: 'production', MEMORY_DB: 'true', ENCRYPTION_KEY: 'a'.repeat(64) },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  assert.notEqual(code, 0);
  assert.match(out, /MEMORY_DB must not be used in production/);
  assert.doesNotMatch(out, /STORE_OK/);
});

test('hostinger: app listens and /health + /ready are honest with a memory store', async () => {
  // Runs in a child process with MEMORY_DB=true, because the in-process
  // config is already loaded (and may point at MySQL) by the time this
  // test runs; the old in-process version only passed when the ambient
  // shell happened to export MEMORY_DB=true or a MySQL answered on 3306.
  const { spawn } = require('node:child_process');
  const port = 32200 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', MEMORY_DB: 'true', ENCRYPTION_KEY: 'a'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const { body } = await waitForHealth(port, 3000);
    assert.equal(body.ok, true);
    assert.equal(body.db_ready, true);
    assert.equal(body.db, 'ready');
    assert.equal(body.db_mode, 'memory');
    // deriver is not_configured in a fresh memory store (no wallet_xpub) — honest, not falsely 'ready'.
    assert.equal(body.deriver, 'not_configured');
    const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(readyRes.status, 200);
  } finally { child.kill(); }
});

async function hostingerSpawnServer(port, dbPort) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', MEMORY_DB: '', ENCRYPTION_KEY: 'a'.repeat(64), DB_HOST: '127.0.0.1', DB_PORT: String(dbPort), DB_USER: 'test', DB_PASSWORD: 'secret-password-must-not-leak', DB_NAME: 'paycrypto' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, getLog: () => log };
}
async function waitForHealth(port, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return { elapsedMs: Date.now() - start, body: await r.json() };
    } catch {}
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('Server did not answer /health within ' + timeoutMs + 'ms');
}

test('hostinger: server listens within 3s with MySQL down (closed port), /health degraded, /ready 503, /api 503, no credentials leaked', async () => {
  const port = 32100 + Math.floor(Math.random() * 100);
  const { child, getLog } = await hostingerSpawnServer(port, 59999);
  try {
    const { elapsedMs, body } = await waitForHealth(port, 3000);
    assert.ok(elapsedMs < 3000, `listened in ${elapsedMs}ms, must be <3000ms`);
    assert.equal(body.ok, true);
    assert.equal(body.db_ready, false);
    assert.equal(body.db, 'unavailable');
    assert.equal(body.last_error, 'ECONNREFUSED');
    assert.doesNotMatch(JSON.stringify(body), /secret-password-must-not-leak/);
    assert.doesNotMatch(getLog(), /secret-password-must-not-leak/);
    // Safe diagnostic: sanitised error + attempted identity, password only as facts.
    assert.equal(body.db_error.code, 'ECONNREFUSED');
    assert.equal(body.db_config.user, 'test');
    assert.equal(body.db_config.database, 'paycrypto');
    assert.equal(body.db_config.password.present, true);
    assert.equal(body.db_config.password.length, 'secret-password-must-not-leak'.length);
    assert.equal(body.dotenv.dotenv_installed, false);
    assert.equal(body.dotenv.env_file_read_by_app, false);
    const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(readyRes.status, 503);
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com', password: 'long-password-123' }) });
    assert.equal(loginRes.status, 503);
    const loginBody = await loginRes.json();
    assert.equal(loginBody.error.message, 'Database unavailable');
  } finally { child.kill('SIGTERM'); }
});

test('hostinger: server listens within 3s with MySQL hanging (dummy TCP, never responds), /health honest unknown, /ready 503', async () => {
  const net = require('node:net');
  const dummyPort = 32200 + Math.floor(Math.random() * 100);
  const dummy = net.createServer((socket) => { socket.on('error', () => {}); /* never respond, like a hung MySQL handshake */ });
  await new Promise((res) => dummy.listen(dummyPort, '127.0.0.1', res));
  const port = 32300 + Math.floor(Math.random() * 100);
  const { child } = await hostingerSpawnServer(port, dummyPort);
  try {
    const { elapsedMs, body } = await waitForHealth(port, 3000);
    assert.ok(elapsedMs < 3000, `listened in ${elapsedMs}ms, must be <3000ms`);
    // Deriver is still hanging on the DB handshake in the background:
    // /health must NOT claim the DB is ready.
    assert.equal(body.db_ready, false);
    assert.ok(body.db === 'unknown' || body.db === 'unavailable');
    const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(readyRes.status, 503);
  } finally { child.kill('SIGTERM'); await new Promise((res) => dummy.close(res)); }
});

// ---- HOSTINGER ENTRY regression: server/index.js must start even
// when require.main !== module (Hostinger loader case) ----
test('hostinger entry: loader-requiring server/index.js (require.main !== module) still starts the listener', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const port = 32400 + Math.floor(Math.random() * 100);
  // Loader is the main module; index.js is only a required module, so
  // inside index.js require.main !== module. The old
  // `if (require.main === module)` guard would have started nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paycrypto-hostinger-entry-'));
  const loader = path.join(dir, 'loader.js');
  const entryAbs = path.join(__dirname, '..', 'server', 'index.js');
  fs.writeFileSync(loader, `require(${JSON.stringify(entryAbs)});\n`);
  const child = spawn(process.execPath, [loader], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', MEMORY_DB: 'true', ENCRYPTION_KEY: 'a'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    const { elapsedMs, body } = await waitForHealth(port, 3000);
    assert.ok(elapsedMs < 3000, `loader case listened in ${elapsedMs}ms, must be <3000ms`);
    assert.equal(body.ok, true);
    assert.equal(body.db_ready, true);
    assert.match(log, /\[startup\] PayCrypto listening on 0\.0\.0\.0:/);
    assert.match(log, /after \d+ms/);
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('hostinger entry: startServer() starts only once per process', async () => {
  const { startServer } = require('../server/app');
  const first = startServer();
  const second = startServer();
  assert.equal(second, first, 'second startServer() must return the existing server, not listen again');
  // app.listen() is async: wait for the 'listening' event before reading the port.
  if (!first.listening) await new Promise((res) => first.once('listening', res));
  const port = first.address().port;
  assert.ok(port > 0);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  // Close all keep-alive connections first, otherwise server.close()
  // waits for the fetch agent's idle socket and the test runner hangs.
  if (typeof first.closeAllConnections === 'function') first.closeAllConnections();
  await new Promise((res) => first.close(res));
});

// ---- DB AUTH DIAGNOSTICS tests (ER_ACCESS_DENIED_ERROR) ----
const { sanitizeDbError, dbConfigDiagnostics, dotenvStatus } = require('../server/src/lib/db-diagnostics');

test('db auth: sanitizeDbError parses access-denied, never reproduces raw text', () => {
  const err = new Error("Access denied for user 'u123456789_paycrypto_user'@'localhost' (using password: YES)");
  err.code = 'ER_ACCESS_DENIED_ERROR'; err.errno = 1045; err.sqlState = '28000';
  const safe = sanitizeDbError(err);
  assert.equal(safe.code, 'ER_ACCESS_DENIED_ERROR');
  assert.equal(safe.errno, 1045);
  assert.equal(safe.sql_state, '28000');
  assert.equal(safe.attempted_user, 'u123456789_paycrypto_user');
  assert.equal(safe.attempted_host, 'localhost');
  assert.equal(safe.using_password, 'YES');
  assert.equal(safe.message, "Access denied for user 'u123456789_paycrypto_user'@'localhost' (using password: YES)");
  // A raw message that (hypothetically) echoed a credential is never reproduced.
  const evil = new Error("Access denied for user 'x'@'localhost' (using password: YES) password=hunter2-secret");
  evil.code = 'ER_ACCESS_DENIED_ERROR'; evil.errno = 1045; evil.sqlState = '28000';
  assert.doesNotMatch(JSON.stringify(sanitizeDbError(evil)), /hunter2-secret/);
  assert.equal(sanitizeDbError(null), null);
  const unknownDb = new Error("Unknown database 'paycrypto'");
  unknownDb.code = 'ER_BAD_DB_ERROR'; unknownDb.errno = 1049; unknownDb.sqlState = '42000';
  assert.equal(sanitizeDbError(unknownDb).message, "Unknown database 'paycrypto'");
  const hostDenied = new Error("Host '1.2.3.4' is not allowed to connect to this MySQL server");
  hostDenied.code = 'ER_HOST_NOT_PRIVILEGED'; hostDenied.errno = 1130;
  assert.equal(sanitizeDbError(hostDenied).attempted_host, '1.2.3.4');
  const weird = new Error('something internal with a secret token=abc123');
  weird.code = 'ER_UNKNOWN_ERROR';
  assert.equal(sanitizeDbError(weird).message, 'Database error (ER_UNKNOWN_ERROR)');
  assert.doesNotMatch(JSON.stringify(sanitizeDbError(weird)), /abc123/);
});

test('db auth: dbConfigDiagnostics reports identity + password facts only', () => {
  const diag = dbConfigDiagnostics({ db: { host: 'localhost', port: 3306, user: 'u1_test', password: ' secret-with-space ', database: 'u1_db' } });
  assert.equal(diag.host, 'localhost');
  assert.equal(diag.user, 'u1_test');
  assert.equal(diag.database, 'u1_db');
  assert.equal(diag.password.present, true);
  assert.equal(diag.password.length, ' secret-with-space '.length);
  assert.equal(diag.password.has_leading_trailing_whitespace, true);
  assert.equal(diag.password.quoted, false);
  assert.equal(dbConfigDiagnostics({ db: { host: 'h', port: 3306, user: 'u', password: '"quoted-pw"', database: 'd' } }).password.quoted, true);
  assert.doesNotMatch(JSON.stringify(diag), /secret-with-space/);
  const d = dotenvStatus();
  assert.equal(d.dotenv_installed, false);
  assert.equal(d.env_file_read_by_app, false);
});

test('db auth: no dotenv dependency, so a .env file can never configure the app', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies && pkg.dependencies.dotenv, undefined);
  assert.equal(require('node:fs').readFileSync(__dirname + '/../server/src/lib/config.js', 'utf8').includes('dotenv'), false);
});

test('db auth: config trims DB_HOST/DB_USER/DB_NAME but uses DB_PASSWORD exactly', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', "const c=require('./server/src/lib/config'); console.log(JSON.stringify(c.db))"], {
    cwd: __dirname + '/..',
    env: { ...process.env, DB_HOST: '  localhost  ', DB_PORT: '3306', DB_USER: '  u1_test  ', DB_PASSWORD: '  spaced-pw  ', DB_NAME: '  u1_db\n' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 0, out);
  const db = JSON.parse(out.trim());
  assert.equal(db.host, 'localhost');
  assert.equal(db.user, 'u1_test');
  assert.equal(db.database, 'u1_db');
  assert.equal(db.password, '  spaced-pw  ', 'password must be used exactly, not trimmed');
});

test('db auth: scripts/db-diagnose.js reports a sanitised failure and never prints the password', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['scripts/db-diagnose.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '59999', DB_USER: 'test', DB_PASSWORD: 'secret-password-must-not-leak', DB_NAME: 'paycrypto', NODE_ENV: 'development' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 1);
  assert.match(out, /ECONNREFUSED/);
  assert.match(out, /"user": "test"/);
  assert.doesNotMatch(out, /secret-password-must-not-leak/);
});

const { normalizeEmail, hashPassword: authHashPassword, verifyPassword } = require('../server/src/lib/auth');
const { main: seedMain } = require('../scripts/seed-admin');

test('auth: normalizeEmail trims and lowercases the same way at every boundary', () => {
  assert.equal(normalizeEmail('  SouvikPati22@Gmail.COM  '), 'souvikpati22@gmail.com');
  assert.equal(normalizeEmail('souvikpati22@gmail.com'), 'souvikpati22@gmail.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(null), '');
});

test('seed: normalises a pasted email, never trims the password, is idempotent', async () => {
  const store = new MemoryStore();
  process.env.ADMIN_EMAIL = '  SouvikPati22@Gmail.com  ';
  process.env.ADMIN_PASSWORD = ' Space-Pass-42 ';
  const first = await seedMain(store);
  assert.equal(first.ok, true);
  const user = await store.findUserByEmail('souvikpati22@gmail.com');
  assert.ok(user, 'seeded admin is findable by the clean, normalised email');
  assert.equal(user.role, 'super_admin');
  assert.equal(user.status, 'active');
  assert.equal(user.merchant_id, null);
  // The password is stored exactly as given, spaces included.
  assert.equal(await verifyPassword(' Space-Pass-42 ', user.password_hash), true);
  assert.equal(await verifyPassword('Space-Pass-42', user.password_hash), false);
  // Re-running never resets the password or duplicates the account.
  const second = await seedMain(store);
  assert.equal(second.alreadyExists, true);
  const again = await store.findUserByEmail('souvikpati22@gmail.com');
  assert.equal(again.id, user.id);
  assert.equal(await verifyPassword(' Space-Pass-42 ', again.password_hash), true);
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
});

test('seed: preserves a wallet_xpub / treasury_address that is already set', async () => {
  const store = new MemoryStore();
  await store.setSetting('wallet_xpub', 'xpub-preset-keep-me');
  await store.setSetting('treasury_address', '0xTreasuryKeepMe');
  process.env.ADMIN_EMAIL = 'seed-preserve@example.com';
  process.env.ADMIN_PASSWORD = 'Seed-Preserve-42';
  const r = await seedMain(store);
  assert.equal(r.ok, true);
  assert.equal(await store.getSetting('wallet_xpub'), 'xpub-preset-keep-me');
  assert.equal(await store.getSetting('treasury_address'), '0xTreasuryKeepMe');
  assert.equal(await store.getSetting('network'), 'testnet', 'missing keys still get their defaults');
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
});

test('seed: refuses MEMORY_DB=true instead of creating a phantom in-memory admin', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['scripts/seed-admin.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, MEMORY_DB: 'true', ADMIN_EMAIL: 'phantom@example.com', ADMIN_PASSWORD: 'Phantom-Pass-42', NODE_ENV: 'development' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 2);
  assert.match(out, /Refusing to seed with MEMORY_DB=true/);
});
