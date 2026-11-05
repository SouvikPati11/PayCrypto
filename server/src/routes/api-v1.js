'use strict';
// Merchant API v1. Auth: Bearer API key (hashed in DB) or dashboard session.
// A merchant can only ever see or touch their own merchant_id — enforced
// here, not left to the frontend.
const express = require('express');
const crypto = require('node:crypto');
const { parseUsdt, formatUsdt, isValidUsdtAmount } = require('../lib/money');
const { validateWithdrawal } = require('../lib/ledger');
const { isValidBscAddress, encryptSecret } = require('../lib/wallet');
const { generateApiKey, hashApiKey } = require('../lib/auth');
const { signWebhook } = require('../lib/webhooks');
const config = require('../lib/config');
const { createPerKeyLimiter } = require('../lib/rate-limit');

function router(store) {
  const r = express.Router();

  async function merchantAuth(req, res, next) {
    // API key first, then session.
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const key = await store.findApiKeyByHash(hashApiKey(auth.slice(7)));
      if (!key) return res.status(401).json({ error: { message: 'Invalid API key' } });
      req.merchantId = key.merchant_id; req.authType = 'api_key'; return next();
    }
    if (req.user && req.user.merchantId) { req.merchantId = req.user.merchantId; req.authType = 'session'; return next(); }
    return res.status(401).json({ error: { message: 'Authentication required' } });
  }
  // PHASE 1: approval gates ALL merchant POSTs (invoices, withdrawals,
  // API keys, webhooks), not just invoices. A pending merchant could
  // previously create API keys and withdrawal requests before approval.
  function approvedOnly(req, res, next) {
    return store.findMerchantById(req.merchantId).then((m) => {
      if (!m) return res.status(404).json({ error: { message: 'Merchant not found' } });
      if (m.status !== 'approved' && req.method === 'POST') {
        return res.status(403).json({ error: { message: 'Merchant is not approved yet' } });
      }
      return next();
    });
  }
  const presentInvoice = (i) => ({ ...i, amount_usdt: i.amount_base_units ? formatUsdt(BigInt(i.amount_base_units)) : null, amount_base_units: String(i.amount_base_units) });

  r.get('/invoices/:reference/public', async (req, res) => {
    const inv = await store.getInvoiceByReference(req.params.reference);
    if (!inv) return res.status(404).json({ error: { message: 'Invoice not found' } });
    return res.json({ invoice: { reference: inv.reference, amount_usdt: formatUsdt(BigInt(inv.amount_base_units)), status: inv.status, deposit_address: inv.deposit_address || null, network: 'BSC', asset: 'USDT', expires_at: inv.expires_at } });
  });

  r.use(merchantAuth);
  // PHASE 2: per-merchant/API-key limiter, in addition to the IP limiter
  // in server/index.js. 600 requests / 15 min per merchant.
  r.use(createPerKeyLimiter({ windowMs: 15 * 60 * 1000, max: 600 }));

  r.get('/balance', async (req, res) => {
    const bal = await store.merchantBalance(req.merchantId);
    const pending = await store.listWithdrawals({ merchant_id: req.merchantId, status: 'pending' });
    const pendingBase = pending.reduce((a, w) => a + BigInt(w.amount_base_units), 0n);
    return res.json({ merchant_id: req.merchantId, available_base_units: bal.toString(), available_usdt: formatUsdt(bal), derived_from_ledger: true, pending_withdrawal_base_units: pendingBase.toString(), pending_withdrawal_usdt: formatUsdt(pendingBase) });
  });

  r.post('/invoices', approvedOnly, async (req, res) => {
    try {
      if (config.emergencyPause || config.maintenanceMode) return res.status(503).json({ error: { message: 'Gateway is paused for maintenance' } });
      const { amount, customerEmail, metadata } = req.body || {};
      if (!isValidUsdtAmount(amount)) return res.status(400).json({ error: { message: 'amount must be a positive USDT value (max 18 decimals)' } });
      const idempotencyKey = req.headers['idempotency-key'] || null;
      const reference = 'PC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      const expiresAt = new Date(Date.now() + config.invoiceExpiryMinutes * 60_000).toISOString();
      const { invoice, duplicate } = await store.createInvoice({
        merchant_id: req.merchantId, reference, customer_email: customerEmail || null,
        amount_base_units: parseUsdt(amount).toString(), expires_at: expiresAt,
        idempotency_key: idempotencyKey, metadata: metadata || {},
      });
      if (duplicate) return res.json({ invoice: presentInvoice(invoice), duplicate: true });
      const addr = await store.allocateDepositAddress({ merchantId: req.merchantId, invoiceId: invoice.id });
      const updated = await store.updateInvoice(invoice.id, { deposit_address: addr.address, deposit_address_id: addr.id });
      await store.logAudit({ actor_type: 'merchant', actor_id: req.user?.sub || null, action: 'invoice.created', entity_type: 'invoice', entity_id: invoice.id });
      return res.status(201).json({ invoice: presentInvoice(updated) });
    } catch (e) { return res.status(e.code === 'DUPLICATE' ? 409 : 500).json({ error: { message: e.message } }); }
  });

  r.get('/invoices', async (req, res) => {
    const list = await store.listInvoices({ merchant_id: req.merchantId, status: req.query.status || null });
    return res.json({ invoices: list.map(presentInvoice) });
  });
  r.get('/invoices/:id', async (req, res) => {
    const inv = await store.getInvoiceById(req.params.id);
    if (!inv || inv.merchant_id !== req.merchantId) return res.status(404).json({ error: { message: 'Invoice not found' } });
    return res.json({ invoice: presentInvoice(inv) });
  });
  r.get('/transactions', async (req, res) => {
    const txs = await store.listTxs({ merchant_id: req.merchantId, status: req.query.status || null });
    return res.json({ transactions: txs.map((t) => ({ ...t, amount_usdt: formatUsdt(BigInt(t.amount_base_units)) })) });
  });

  r.post('/withdrawals', approvedOnly, async (req, res) => {
    try {
      const { destination, amount } = req.body || {};
      if (!isValidBscAddress(destination)) return res.status(400).json({ error: { message: 'Invalid BNB Smart Chain destination address' } });
      if (!isValidUsdtAmount(amount)) return res.status(400).json({ error: { message: 'Invalid withdrawal amount' } });
      const available = await store.merchantBalance(req.merchantId);
      const check = validateWithdrawal({ availableBaseUnits: available, amountUsdt: amount, feeUsdt: config.withdrawalFeeUsdt, minUsdt: config.minWithdrawalUsdt, maxUsdt: config.maxWithdrawalUsdt });
      if (!check.ok) return res.status(400).json({ error: { message: check.error } });
      const w = await store.createWithdrawal({
        merchant_id: req.merchantId, destination_address: destination,
        amount_base_units: check.amount.toString(), fee_base_units: check.fee.toString(), net_base_units: check.net.toString(),
      });
      await store.logAudit({ actor_type: 'merchant', actor_id: req.user?.sub || null, action: 'withdrawal.requested', entity_type: 'withdrawal', entity_id: w.id });
      return res.status(201).json({ withdrawal: w, note: 'Pending admin approval. No funds move until approved, and no automatic broadcast happens unless WITHDRAWAL_AUTO_BROADCAST is enabled with a signing service.' });
    } catch (e) { return res.status(500).json({ error: { message: e.message } }); }
  });
  r.get('/withdrawals', async (req, res) => {
    const list = await store.listWithdrawals({ merchant_id: req.merchantId, status: req.query.status || null });
    return res.json({ withdrawals: list });
  });
  r.get('/withdrawals/:id', async (req, res) => {
    const w = await store.getWithdrawalById(req.params.id);
    if (!w || w.merchant_id !== req.merchantId) return res.status(404).json({ error: { message: 'Withdrawal not found' } });
    return res.json({ withdrawal: w });
  });

  r.post('/api-keys', approvedOnly, async (req, res) => {
    const live = req.body?.live === true && config.paymentsLive;
    const { plaintext, hash, prefix } = generateApiKey(live);
    const key = await store.createApiKey({ merchant_id: req.merchantId, name: req.body?.name || 'Default', key_prefix: prefix, key_hash: hash, live });
    return res.status(201).json({ api_key: { id: key.id, name: key.name, key_prefix: prefix, live }, plaintext, warning: 'Copy this key now — it is stored only as a hash and cannot be shown again.' });
  });
  r.get('/api-keys', async (req, res) => res.json({ api_keys: await store.listApiKeys(req.merchantId) }));
  r.post('/api-keys/:id/revoke', async (req, res) => { await store.revokeApiKey(req.params.id); return res.json({ ok: true }); });

  r.post('/webhooks', approvedOnly, async (req, res) => {
    const { url, events } = req.body || {};
    if (!url || !/^https:\/\//.test(url)) return res.status(400).json({ error: { message: 'Webhook URL must be https://' } });
    const secret = crypto.randomBytes(32).toString('hex');
    const wh = await store.createWebhook({ merchant_id: req.merchantId, url, secret_encrypted: encryptSecret(secret), events: events || ['invoice.paid'] });
    return res.status(201).json({ webhook: { id: wh.id, url: wh.url, events: wh.events }, secret, warning: 'Store this webhook secret — it is used to verify HMAC signatures.' });
  });
  r.get('/webhooks', async (req, res) => res.json({ webhooks: await store.listWebhooks(req.merchantId) }));
  // PHASE 2: webhook logs must not leak HMAC signatures to API callers.
  // The signature is not the secret, but it is not needed by the caller
  // and must not be replayable from a log listing.
  r.get('/webhook-logs', async (req, res) => {
    const logs = await store.listWebhookLogs(req.merchantId);
    return res.json({ logs: logs.map(({ signature, ...rest }) => rest) });
  });

  return r;
}
module.exports = router;
