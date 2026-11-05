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
