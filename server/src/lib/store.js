'use strict';
// Store abstraction: MySQL in production, in-memory for tests / demo.
// Both backends expose the same methods so routes never branch on storage.
// IMPORTANT: in-memory mode is explicitly not production storage — it loses
// data on restart and must never be used with real funds. Production requires
// MySQL (see db/migrations) and MEMORY_DB=false.
const config = require('./config');
const { deriveBalance } = require('./ledger');

let mysql = null;
function pool() {
  if (!mysql) mysql = require('mysql2/promise');
  if (!pool._p) pool._p = mysql.createPool({ ...config.db, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
  return pool._p;
}
function dupError(msg) { const e = new Error(msg); e.code = 'DUPLICATE'; return e; }

class MemoryStore {
  constructor() {
    this.users = new Map(); this.merchants = new Map(); this.invoices = new Map();
    this.addresses = new Map(); this.txs = new Map(); this.ledger = [];
    this.withdrawals = new Map(); this.sweeps = new Map(); this.apiKeys = new Map();
    this.webhooks = new Map(); this.webhookLogs = []; this.audit = []; this.sessions = new Map();
    this.settings = new Map(Object.entries({
      network: config.network, chain_id: String(config.chainId),
      usdt_contract: config.usdtContractForNetwork() || '',
      confirmations: String(config.confirmations), invoice_expiry_minutes: String(config.invoiceExpiryMinutes),
      min_withdrawal_usdt: config.minWithdrawalUsdt, max_withdrawal_usdt: config.maxWithdrawalUsdt,
      withdrawal_fee_usdt: config.withdrawalFeeUsdt, maintenance_mode: 'false', emergency_pause: 'false',
      treasury_address: config.treasuryAddress, wallet_xpub: '',
    }));
    this.checkpoint = { network: config.network, last_block_number: 0, last_block_hash: '' };
    this.nextId = 1; this.nextIndex = 0; this.deriver = null;
  }
  setAddressDeriver(fn) { this.deriver = fn; }
  _id() { return this.nextId++; }
  async getSetting(k) { return this.settings.get(k); }
  async getAllSettings() { return Object.fromEntries(this.settings); }
  async setSetting(k, v) { this.settings.set(k, String(v)); return true; }
  async createUser(u) {
    for (const x of this.users.values()) if (x.email === u.email) throw dupError('Email already registered');
    const row = { id: this._id(), ...u, totp_enabled: false, totp_secret_encrypted: null, status: 'active', created_at: new Date().toISOString() };
    this.users.set(row.id, row); return row;
  }
  async findUserByEmail(email) { return [...this.users.values()].find((x) => x.email === email) || null; }
  async findUserById(id) { return this.users.get(Number(id)) || null; }
  async updateUser(id, patch) { const u = this.users.get(Number(id)); if (!u) return null; Object.assign(u, patch); return u; }
  async createMerchant(m) {
    const row = { id: this._id(), ...m, status: m.status || 'pending', created_at: new Date().toISOString() };
    this.merchants.set(row.id, row); return row;
  }
  async findMerchantById(id) { return this.merchants.get(Number(id)) || null; }
  async findMerchantByUserId(uid) { return [...this.merchants.values()].find((x) => x.user_id === Number(uid)) || null; }
  async listMerchants() { return [...this.merchants.values()]; }
  async updateMerchant(id, patch) { const m = this.merchants.get(Number(id)); if (!m) return null; Object.assign(m, patch); return m; }
  async allocateDepositAddress({ merchantId, invoiceId }) {
    if (!this.deriver) throw new Error('HD wallet not initialized: set wallet_xpub or run scripts/init-wallet.js (see docs/WALLET.md)');
    for (const a of this.addresses.values()) if (a.invoice_id === Number(invoiceId)) return a;
    const index = this.nextIndex++;
    const address = this.deriver(index);
    for (const a of this.addresses.values()) if (a.address.toLowerCase() === address.toLowerCase()) throw dupError('Deposit address already allocated');
    const row = { id: this._id(), merchant_id: merchantId, invoice_id: invoiceId, address, derivation_index: index, network: config.network, status: 'assigned', created_at: new Date().toISOString() };
    this.addresses.set(row.id, row); return row;
  }
  async findAddressByValue(address) { return [...this.addresses.values()].find((x) => x.address.toLowerCase() === String(address).toLowerCase()) || null; }
  async listAddresses() { return [...this.addresses.values()]; }
  async createInvoice(inv) {
    if (inv.idempotency_key) {
      const ex = [...this.invoices.values()].find((x) => x.merchant_id === inv.merchant_id && x.idempotency_key === inv.idempotency_key);
      if (ex) return { invoice: ex, duplicate: true };
    }
    const row = { id: this._id(), status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...inv };
    this.invoices.set(row.id, row); return { invoice: row, duplicate: false };
  }
  async getInvoiceById(id) { return this.invoices.get(Number(id)) || null; }
  async getInvoiceByReference(ref) { return [...this.invoices.values()].find((x) => x.reference === ref) || null; }
  async listInvoices(filter = {}) {
    return [...this.invoices.values()].filter((x) => (!filter.merchant_id || x.merchant_id === Number(filter.merchant_id)) && (!filter.status || x.status === filter.status));
  }
  async updateInvoice(id, patch) { const i = this.invoices.get(Number(id)); if (!i) return null; Object.assign(i, patch, { updated_at: new Date().toISOString() }); return i; }
  async recordBlockchainTx(tx) {
    const ex = [...this.txs.values()].find((x) => x.tx_hash === tx.tx_hash && x.log_index === tx.log_index);
    if (ex) return { tx: ex, duplicate: true };
    const row = { id: this._id(), status: 'pending', confirmations: 0, created_at: new Date().toISOString(), ...tx };
    this.txs.set(row.id, row); return { tx: row, duplicate: false };
  }
  async getTxById(id) { return this.txs.get(Number(id)) || null; }
  async listTxs(filter = {}) { return [...this.txs.values()].filter((x) => (!filter.merchant_id || x.merchant_id === Number(filter.merchant_id)) && (!filter.status || x.status === filter.status)); }
  async updateTx(id, patch) { const t = this.txs.get(Number(id)); if (!t) return null; Object.assign(t, patch); return t; }
  async addLedgerEntry(entry) {
    if (this.ledger.find((x) => x.reference_key === entry.reference_key)) throw dupError('Ledger entry already exists for this reference (duplicate credit prevented)');
    const row = { id: this._id(), created_at: new Date().toISOString(), ...entry };
    this.ledger.push(row); return row;
  }
  async ledgerEntries(merchantId) { return this.ledger.filter((x) => x.merchant_id === Number(merchantId)); }
  async merchantBalance(merchantId) {
    const entries = await this.ledgerEntries(merchantId);
    // Available = derived balance. Pending balance is computed by callers
    // from confirming invoices, not from a mutable column.
    return deriveBalance(entries);
  }
  async createWithdrawal(w) {
    const row = { id: this._id(), status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...w };
    this.withdrawals.set(row.id, row); return row;
  }
  async getWithdrawalById(id) { return this.withdrawals.get(Number(id)) || null; }
  async listWithdrawals(filter = {}) { return [...this.withdrawals.values()].filter((x) => (!filter.merchant_id || x.merchant_id === Number(filter.merchant_id)) && (!filter.status || x.status === filter.status)); }
  async updateWithdrawal(id, patch) {
    const w = this.withdrawals.get(Number(id)); if (!w) return null;
    if (patch.tx_hash) for (const x of this.withdrawals.values()) if (x.tx_hash === patch.tx_hash && x.id !== w.id) throw dupError('Withdrawal tx_hash already recorded');
    Object.assign(w, patch, { updated_at: new Date().toISOString() }); return w;
  }
  async createSweepJob(job) {
    const ex = [...this.sweeps.values()].find((x) => x.job_key === job.job_key);
    if (ex) return { job: ex, duplicate: true };
    const row = { id: this._id(), status: 'pending', created_at: new Date().toISOString(), ...job };
    this.sweeps.set(row.id, row); return { job: row, duplicate: false };
  }
  async listSweepJobs() { return [...this.sweeps.values()]; }
  async updateSweepJob(id, patch) {
    const j = this.sweeps.get(Number(id)); if (!j) return null;
    if (patch.tx_hash) for (const x of this.sweeps.values()) if (x.tx_hash === patch.tx_hash && x.id !== j.id) throw dupError('Sweep tx_hash already recorded');
    Object.assign(j, patch); return j;
  }
  async createApiKey(k) {
    const row = { id: this._id(), revoked_at: null, created_at: new Date().toISOString(), ...k };
    this.apiKeys.set(row.id, row); return row;
  }
  async listApiKeys(merchantId) { return [...this.apiKeys.values()].filter((x) => x.merchant_id === Number(merchantId)); }
  async findApiKeyByHash(hash) { return [...this.apiKeys.values()].find((x) => x.key_hash === hash && !x.revoked_at) || null; }
  async revokeApiKey(id) { const k = this.apiKeys.get(Number(id)); if (k) k.revoked_at = new Date().toISOString(); return k; }
  async createWebhook(w) { const row = { id: this._id(), active: true, created_at: new Date().toISOString(), ...w }; this.webhooks.set(row.id, row); return row; }
  async getWebhooksFull(merchantId) { return [...this.webhooks.values()].filter((x) => x.merchant_id === Number(merchantId) && x.active); }
  async listWebhooks(merchantId) { return [...this.webhooks.values()].filter((x) => x.merchant_id === Number(merchantId)); }
  async queueWebhookLog(log) { const row = { id: this._id(), status: 'pending', attempts: 0, created_at: new Date().toISOString(), ...log }; this.webhookLogs.push(row); return row; }
  async listWebhookLogs(merchantId) { return this.webhookLogs.filter((x) => x.merchant_id === Number(merchantId)); }
  async updateWebhookLog(id, patch) { const l = this.webhookLogs.find((x) => x.id === Number(id)); if (l) Object.assign(l, patch); return l; }
  async logAudit(a) { const row = { id: this._id(), created_at: new Date().toISOString(), ...a }; this.audit.push(row); return row; }
  async listAuditLogs() { return [...this.audit].reverse().slice(0, 200); }
  async getCheckpoint() { return this.checkpoint; }
  async setCheckpoint(blockNumber, blockHash) { this.checkpoint = { network: config.network, last_block_number: blockNumber, last_block_hash: blockHash || '' }; return this.checkpoint; }
}

class MysqlStore {
  setAddressDeriver(fn) { this.deriver = fn; }
  async q(sql, params = []) { const [rows] = await pool().query(sql, params); return rows; }
  async getSetting(k) { const r = await this.q('SELECT `value` FROM system_settings WHERE `key`=?', [k]); return r[0]?.value ?? null; }
  async getAllSettings() { const r = await this.q('SELECT `key`,`value` FROM system_settings'); return Object.fromEntries(r.map((x) => [x.key, x.value])); }
  async setSetting(k, v) { await this.q('INSERT INTO system_settings (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)', [k, String(v)]); return true; }
  async createUser(u) {
    try { const r = await this.q('INSERT INTO users (email,password_hash,role,merchant_id) VALUES (?,?,?,?)', [u.email, u.password_hash, u.role, u.merchant_id || null]); return this.findUserById(r.insertId); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw dupError('Email already registered'); throw e; }
  }
  async findUserByEmail(email) { const r = await this.q('SELECT * FROM users WHERE email=?', [email]); return r[0] || null; }
  async findUserById(id) { const r = await this.q('SELECT * FROM users WHERE id=?', [id]); return r[0] || null; }
  async updateUser(id, patch) {
    const keys = Object.keys(patch); if (!keys.length) return this.findUserById(id);
    await this.q(`UPDATE users SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); return this.findUserById(id);
  }
  async createMerchant(m) { const r = await this.q('INSERT INTO merchants (user_id,business_name,contact_email,website,status) VALUES (?,?,?,?,?)', [m.user_id, m.business_name, m.contact_email || null, m.website || null, m.status || 'pending']); return this.findMerchantById(r.insertId); }
  async findMerchantById(id) { const r = await this.q('SELECT * FROM merchants WHERE id=?', [id]); return r[0] || null; }
  async findMerchantByUserId(uid) { const r = await this.q('SELECT * FROM merchants WHERE user_id=?', [uid]); return r[0] || null; }
  async listMerchants() { return this.q('SELECT * FROM merchants ORDER BY id DESC'); }
  async updateMerchant(id, patch) { const keys = Object.keys(patch); await this.q(`UPDATE merchants SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); return this.findMerchantById(id); }
  async allocateDepositAddress({ merchantId, invoiceId }) {
    if (!this.deriver) throw new Error('HD wallet not initialized: set wallet_xpub or run scripts/init-wallet.js (see docs/WALLET.md)');
    const conn = await pool().getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.query('SELECT * FROM deposit_addresses WHERE invoice_id=? FOR UPDATE', [invoiceId]);
      if (existing[0]) { await conn.commit(); return existing[0]; }
      const [rows] = await conn.query('SELECT COALESCE(MAX(derivation_index),-1) AS m FROM deposit_addresses FOR UPDATE');
      const index = Number(rows[0].m) + 1;
      const address = this.deriver(index);
      const [r] = await conn.query('INSERT INTO deposit_addresses (merchant_id,invoice_id,address,derivation_index,network,status) VALUES (?,?,?,?,?,?)', [merchantId, invoiceId, address, index, config.network, 'assigned']);
      await conn.commit();
      const [out] = await conn.query('SELECT * FROM deposit_addresses WHERE id=?', [r.insertId]); return out[0];
    } catch (e) { await conn.rollback(); if (e.code === 'ER_DUP_ENTRY') throw dupError('Deposit address already allocated'); throw e; }
    finally { conn.release(); }
  }
  async findAddressByValue(address) { const r = await this.q('SELECT * FROM deposit_addresses WHERE LOWER(address)=LOWER(?)', [address]); return r[0] || null; }
  async listAddresses() { return this.q('SELECT * FROM deposit_addresses ORDER BY derivation_index ASC'); }
  async createInvoice(inv) {
    if (inv.idempotency_key) {
      const ex = await this.q('SELECT * FROM invoices WHERE merchant_id=? AND idempotency_key=?', [inv.merchant_id, inv.idempotency_key]);
      if (ex[0]) return { invoice: ex[0], duplicate: true };
    }
    const r = await this.q('INSERT INTO invoices (merchant_id,reference,customer_email,amount_base_units,currency,network,status,expires_at,idempotency_key,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)', [inv.merchant_id, inv.reference, inv.customer_email || null, inv.amount_base_units, 'USDT', 'BSC', 'pending', inv.expires_at, inv.idempotency_key || null, JSON.stringify(inv.metadata || {})]);
    return { invoice: await this.getInvoiceById(r.insertId), duplicate: false };
  }
  async getInvoiceById(id) { const r = await this.q('SELECT * FROM invoices WHERE id=?', [id]); return r[0] || null; }
  async getInvoiceByReference(ref) { const r = await this.q('SELECT * FROM invoices WHERE reference=?', [ref]); return r[0] || null; }
  async listInvoices(filter = {}) {
    let sql = 'SELECT * FROM invoices WHERE 1=1'; const p = [];
    if (filter.merchant_id) { sql += ' AND merchant_id=?'; p.push(filter.merchant_id); }
    if (filter.status) { sql += ' AND status=?'; p.push(filter.status); }
    sql += ' ORDER BY id DESC LIMIT 200'; return this.q(sql, p);
  }
  async updateInvoice(id, patch) { const keys = Object.keys(patch); await this.q(`UPDATE invoices SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); return this.getInvoiceById(id); }
  async recordBlockchainTx(tx) {
    try {
      const r = await this.q('INSERT INTO blockchain_transactions (tx_hash,log_index,block_number,block_hash,from_address,to_address,token_contract,amount_base_units,invoice_id,merchant_id,status,confirmations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [tx.tx_hash, tx.log_index, tx.block_number, tx.block_hash || null, tx.from_address, tx.to_address, tx.token_contract, tx.amount_base_units, tx.invoice_id || null, tx.merchant_id || null, tx.status || 'pending', tx.confirmations || 0]);
      return { tx: await this.getTxById(r.insertId), duplicate: false };
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') { const r = await this.q('SELECT * FROM blockchain_transactions WHERE tx_hash=? AND log_index=?', [tx.tx_hash, tx.log_index]); return { tx: r[0], duplicate: true }; } throw e; }
  }
  async getTxById(id) { const r = await this.q('SELECT * FROM blockchain_transactions WHERE id=?', [id]); return r[0] || null; }
  async listTxs(filter = {}) { let sql = 'SELECT * FROM blockchain_transactions WHERE 1=1'; const p = []; if (filter.merchant_id) { sql += ' AND merchant_id=?'; p.push(filter.merchant_id); } if (filter.status) { sql += ' AND status=?'; p.push(filter.status); } sql += ' ORDER BY id DESC LIMIT 200'; return this.q(sql, p); }
  async updateTx(id, patch) { const keys = Object.keys(patch); await this.q(`UPDATE blockchain_transactions SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); return this.getTxById(id); }
  async addLedgerEntry(entry) {
    try { const r = await this.q('INSERT INTO ledger_entries (merchant_id,invoice_id,blockchain_tx_id,withdrawal_id,entry_type,amount_base_units,description,reference_key) VALUES (?,?,?,?,?,?,?,?)', [entry.merchant_id, entry.invoice_id || null, entry.blockchain_tx_id || null, entry.withdrawal_id || null, entry.entry_type, entry.amount_base_units, entry.description || '', entry.reference_key]); return { id: r.insertId, ...entry }; }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw dupError('Ledger entry already exists for this reference (duplicate credit prevented)'); throw e; }
  }
  async ledgerEntries(merchantId) { return this.q('SELECT * FROM ledger_entries WHERE merchant_id=? ORDER BY id ASC', [merchantId]); }
  async merchantBalance(merchantId) { const r = await this.q("SELECT COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount_base_units ELSE -amount_base_units END),0) AS bal FROM ledger_entries WHERE merchant_id=?", [merchantId]); return BigInt(String(r[0].bal || '0')); }
  async createWithdrawal(w) { const r = await this.q('INSERT INTO withdrawals (merchant_id,destination_address,amount_base_units,fee_base_units,net_base_units,status) VALUES (?,?,?,?,?,?)', [w.merchant_id, w.destination_address, w.amount_base_units, w.fee_base_units, w.net_base_units, 'pending']); return this.getWithdrawalById(r.insertId); }
  async getWithdrawalById(id) { const r = await this.q('SELECT * FROM withdrawals WHERE id=?', [id]); return r[0] || null; }
  async listWithdrawals(filter = {}) { let sql = 'SELECT * FROM withdrawals WHERE 1=1'; const p = []; if (filter.merchant_id) { sql += ' AND merchant_id=?'; p.push(filter.merchant_id); } if (filter.status) { sql += ' AND status=?'; p.push(filter.status); } sql += ' ORDER BY id DESC LIMIT 200'; return this.q(sql, p); }
  async updateWithdrawal(id, patch) { const keys = Object.keys(patch); try { await this.q(`UPDATE withdrawals SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw dupError('Withdrawal tx_hash already recorded'); throw e; } return this.getWithdrawalById(id); }
  async createSweepJob(job) { const ex = await this.q('SELECT * FROM sweep_jobs WHERE job_key=?', [job.job_key]); if (ex[0]) return { job: ex[0], duplicate: true }; const r = await this.q('INSERT INTO sweep_jobs (job_key,treasury_address,status,total_base_units) VALUES (?,?,?,?)', [job.job_key, job.treasury_address, 'pending', job.total_base_units || '0']); const rows = await this.q('SELECT * FROM sweep_jobs WHERE id=?', [r.insertId]); return { job: rows[0], duplicate: false }; }
  async listSweepJobs() { return this.q('SELECT * FROM sweep_jobs ORDER BY id DESC LIMIT 200'); }
  async updateSweepJob(id, patch) { const keys = Object.keys(patch); await this.q(`UPDATE sweep_jobs SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); const r = await this.q('SELECT * FROM sweep_jobs WHERE id=?', [id]); return r[0] || null; }
  async createApiKey(k) { const r = await this.q('INSERT INTO api_keys (merchant_id,name,key_prefix,key_hash,live) VALUES (?,?,?,?,?)', [k.merchant_id, k.name, k.key_prefix, k.key_hash, k.live ? 1 : 0]); const rows = await this.q('SELECT * FROM api_keys WHERE id=?', [r.insertId]); return rows[0]; }
  async listApiKeys(merchantId) { return this.q('SELECT id,merchant_id,name,key_prefix,live,last_used_at,revoked_at,created_at FROM api_keys WHERE merchant_id=? ORDER BY id DESC', [merchantId]); }
  async findApiKeyByHash(hash) { const r = await this.q('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', [hash]); return r[0] || null; }
  async revokeApiKey(id) { await this.q('UPDATE api_keys SET revoked_at=NOW() WHERE id=?', [id]); return true; }
  async createWebhook(w) { const r = await this.q('INSERT INTO webhooks (merchant_id,url,secret_encrypted,events,active) VALUES (?,?,?,?,?)', [w.merchant_id, w.url, w.secret_encrypted, JSON.stringify(w.events || ['invoice.paid']), 1]); const rows = await this.q('SELECT * FROM webhooks WHERE id=?', [r.insertId]); return rows[0]; }
  async listWebhooks(merchantId) { return this.q('SELECT id,merchant_id,url,events,active,created_at FROM webhooks WHERE merchant_id=? ORDER BY id DESC', [merchantId]); }
  async getWebhooksFull(merchantId) { return this.q('SELECT * FROM webhooks WHERE merchant_id=? AND active=1 ORDER BY id DESC', [merchantId]); }
  async queueWebhookLog(log) { const r = await this.q('INSERT INTO webhook_logs (webhook_id,merchant_id,invoice_id,event,payload,signature,status,attempts) VALUES (?,?,?,?,?,?,?,?)', [log.webhook_id, log.merchant_id, log.invoice_id || null, log.event, JSON.stringify(log.payload), log.signature || '', 'pending', 0]); return { id: r.insertId, ...log }; }
  async listWebhookLogs(merchantId) { return this.q('SELECT * FROM webhook_logs WHERE merchant_id=? ORDER BY id DESC LIMIT 200', [merchantId]); }
  async updateWebhookLog(id, patch) { const keys = Object.keys(patch); await this.q(`UPDATE webhook_logs SET ${keys.map((k) => `\`${k}\`=?`).join(',')} WHERE id=?`, [...Object.values(patch), id]); return true; }
  async logAudit(a) { await this.q('INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,details,ip_address) VALUES (?,?,?,?,?,?,?)', [a.actor_type, a.actor_id || null, a.action, a.entity_type || null, a.entity_id || null, JSON.stringify(a.details || {}), a.ip_address || null]); return true; }
  async listAuditLogs() { return this.q('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200'); }
  async getCheckpoint() { const r = await this.q('SELECT * FROM monitor_checkpoints WHERE network=?', [config.network]); return r[0] || { network: config.network, last_block_number: 0, last_block_hash: '' }; }
  async setCheckpoint(blockNumber, blockHash) { await this.q('INSERT INTO monitor_checkpoints (network,last_block_number,last_block_hash) VALUES (?,?,?) ON DUPLICATE KEY UPDATE last_block_number=VALUES(last_block_number), last_block_hash=VALUES(last_block_hash)', [config.network, blockNumber, blockHash || '']); return this.getCheckpoint(); }
}

function createStore() {
  if (config.memoryDb) return new MemoryStore();
  return new MysqlStore();
}
module.exports = { MemoryStore, MysqlStore, createStore };
