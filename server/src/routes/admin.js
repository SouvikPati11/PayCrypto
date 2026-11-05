'use strict';
// Admin API. Roles: super_admin (all), admin (manage), support (read-only).
// Every state change is audit-logged.
const express = require('express');
const { can } = require('../lib/auth');
const { formatUsdt } = require('../lib/money');
const config = require('../lib/config');

function router(store) {
  const r = express.Router();
  r.use((req, res, next) => {
    if (!req.user || !['super_admin', 'admin', 'support'].includes(req.user.role)) return res.status(403).json({ error: { message: 'Admin access required' } });
    return next();
  });
  const need = (perm) => (req, res, next) => (can(req.user.role, perm) ? next() : res.status(403).json({ error: { message: 'Permission denied: ' + perm } }));

  r.get('/overview', async (req, res) => {
    const merchants = await store.listMerchants();
    const invoices = await store.listInvoices({});
    const txs = await store.listTxs({});
    const withdrawals = await store.listWithdrawals({});
    const addresses = await store.listAddresses();
    const sweeps = await store.listSweepJobs();
    const confirmed = txs.filter((t) => t.status === 'confirmed');
    const totalReceived = confirmed.reduce((a, t) => a + BigInt(t.amount_base_units), 0n);
    // PHASE 1: merchant liabilities are now actually computed (sum of
    // derived ledger balances), not just described in a note.
    let totalLiabilities = 0n;
    for (const m of merchants) totalLiabilities += await store.merchantBalance(m.id);
    return res.json({
      total_merchants: merchants.length, total_invoices: invoices.length, total_payments: txs.length,
      total_usdt_received: formatUsdt(totalReceived), total_merchant_liabilities_usdt: formatUsdt(totalLiabilities), pending_withdrawals: withdrawals.filter((w) => w.status === 'pending').length,
      successful_transactions: confirmed.length, failed_transactions: txs.filter((t) => t.status === 'failed').length,
      deposit_addresses: addresses.length, sweep_jobs: sweeps.length, treasury_address: config.treasuryAddress || null,
      note: 'Merchant liabilities are the sum of merchant ledger balances; treasury balance is read on-chain, not stored here.',
    });
  });
  r.get('/merchants', need('merchants:read'), async (req, res) => res.json({ merchants: await store.listMerchants() }));
  r.patch('/merchants/:id', need('merchants:manage'), async (req, res) => {
    const { status } = req.body || {};
    if (!['approved', 'suspended', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: { message: 'Invalid status' } });
    const m = await store.updateMerchant(req.params.id, { status });
    await store.logAudit({ actor_type: 'admin', actor_id: req.user.sub, action: 'merchant.status_changed', entity_type: 'merchant', entity_id: m.id, details: { status }, ip_address: req.ip });
    return res.json({ merchant: m });
  });
  r.get('/merchants/:id/transactions', need('merchants:read'), async (req, res) => {
    const txs = await store.listTxs({ merchant_id: req.params.id });
    const entries = await store.ledgerEntries(req.params.id);
    const bal = await store.merchantBalance(req.params.id);
    return res.json({ transactions: txs, ledger: entries, balance_usdt: formatUsdt(bal) });
  });
  r.get('/invoices', need('invoices:read'), async (req, res) => res.json({ invoices: await store.listInvoices({ status: req.query.status || null }) }));
  r.get('/transactions', async (req, res) => res.json({ transactions: await store.listTxs({ status: req.query.status || null }) }));
  r.get('/wallets', need('wallets:read'), async (req, res) => {
    const addresses = await store.listAddresses();
    const settings = await store.getAllSettings();
    return res.json({ addresses, wallet_xpub_set: !!settings.wallet_xpub, treasury_address: config.treasuryAddress || null, note: 'Individual address balances are read on-chain via the USDT contract; they are not stored as editable columns.' });
  });
  r.get('/withdrawals', need('withdrawals:approve'), async (req, res) => res.json({ withdrawals: await store.listWithdrawals({ status: req.query.status || null }) }));
  r.patch('/withdrawals/:id', need('withdrawals:approve'), async (req, res) => {
    const { status, tx_hash, admin_note } = req.body || {};
    if (!['approved', 'rejected', 'awaiting_broadcast', 'broadcast', 'confirmed', 'failed'].includes(status)) return res.status(400).json({ error: { message: 'Invalid status' } });
    const w = await store.getWithdrawalById(req.params.id);
    if (!w) return res.status(404).json({ error: { message: 'Withdrawal not found' } });
    if (status === 'approved' && config.withdrawalAutoBroadcast) {
      return res.status(400).json({ error: { message: 'Automatic broadcast is disabled in this build: approve to awaiting_broadcast and record the externally signed tx_hash. See docs/PRODUCTION_READINESS.md.' } });
    }
    const patch = { status };
    if (tx_hash) patch.tx_hash = tx_hash;
    if (admin_note) patch.admin_note = admin_note;
    // PHASE 1: balance check at confirmation time. Creation-time checks
    // alone do not prevent multiple approved withdrawals exceeding the
    // balance before any of them is confirmed.
    if (status === 'confirmed' && tx_hash) {
      const bal = await store.merchantBalance(w.merchant_id);
      if (BigInt(w.amount_base_units) > bal) return res.status(400).json({ error: { message: 'Insufficient merchant balance to confirm this withdrawal' } });
    }
    const updated = await store.updateWithdrawal(w.id, patch);
    // Ledger debit happens ONLY when a withdrawal is confirmed on-chain
    // with a tx_hash, in a single store call guarded by reference_key.
    if (status === 'confirmed' && tx_hash) {
      try {
        await store.addLedgerEntry({ merchant_id: w.merchant_id, withdrawal_id: w.id, entry_type: 'debit', amount_base_units: String(w.amount_base_units), description: `Withdrawal ${tx_hash}`, reference_key: `withdrawal:${w.id}` });
      } catch (e) { if (e.code !== 'DUPLICATE') throw e; }
    }
    await store.logAudit({ actor_type: 'admin', actor_id: req.user.sub, action: 'withdrawal.status_changed', entity_type: 'withdrawal', entity_id: w.id, details: { status, tx_hash: !!tx_hash }, ip_address: req.ip });
    return res.json({ withdrawal: updated });
  });
  r.get('/sweeps', need('sweeps:manage'), async (req, res) => res.json({ sweeps: await store.listSweepJobs() }));
  r.post('/sweeps', need('sweeps:manage'), async (req, res) => {
    if (config.autoSweep) return res.status(400).json({ error: { message: 'Automatic sweeping is disabled by policy until signing, fee and approval reviews pass. Create a job for manual review only.' } });
    const { job_key, treasury_address, total_base_units } = req.body || {};
    if (!job_key || !treasury_address) return res.status(400).json({ error: { message: 'job_key and treasury_address are required' } });
    const { job, duplicate } = await store.createSweepJob({ job_key, treasury_address, total_base_units: total_base_units || '0' });
    await store.logAudit({ actor_type: 'admin', actor_id: req.user.sub, action: 'sweep.created', entity_type: 'sweep_job', entity_id: job.id, details: { job_key } });
    return res.status(duplicate ? 200 : 201).json({ sweep: job, duplicate });
  });
  r.patch('/sweeps/:id', need('sweeps:manage'), async (req, res) => {
    const { status, tx_hash } = req.body || {};
    if (!['review', 'approved', 'executing', 'completed', 'failed'].includes(status)) return res.status(400).json({ error: { message: 'Invalid status' } });
    const j = await store.updateSweepJob(req.params.id, { status, ...(tx_hash ? { tx_hash } : {}) });
    await store.logAudit({ actor_type: 'admin', actor_id: req.user.sub, action: 'sweep.status_changed', entity_type: 'sweep_job', entity_id: j.id, details: { status } });
    return res.json({ sweep: j });
  });
  r.get('/settings', need('settings:read'), async (req, res) => res.json({ settings: await store.getAllSettings(), env: { network: config.network, chain_id: config.chainId, payments_live: config.paymentsLive, auto_sweep: config.autoSweep, emergency_pause: config.emergencyPause } }));
  r.patch('/settings', need('settings:read'), async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: { message: 'Only super_admin can change settings' } });
    for (const [k, v] of Object.entries(req.body || {})) await store.setSetting(k, v);
    await store.logAudit({ actor_type: 'admin', actor_id: req.user.sub, action: 'settings.changed', entity_type: 'system_settings', details: req.body });
    return res.json({ settings: await store.getAllSettings() });
  });
  r.get('/audit', need('audit:read'), async (req, res) => res.json({ logs: await store.listAuditLogs() }));
  return r;
}
module.exports = router;
