'use strict';
// Signer HTTP service factory. Binds to a private address by default
// (SIGNER_HOST, default 127.0.0.1) and is meant to sit behind a private
// network / firewall allowlist, never directly on the public internet.
// All signing requests require HMAC auth (see core.verifySignerRequest).
// No endpoint ever returns a private key, mnemonic, or signed raw tx.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifySignerRequest, signJob } = require('./core');

function createSignerApp({ cfg, keyProvider, provider, state, audit }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
  const seenNonces = new Map();

  app.get('/health', (req, res) => res.json({ ok: true, network: cfg.network, chain_id: cfg.chainId, dry_run: !!cfg.dryRun, allow_mainnet: !!cfg.allowMainnet, treasury_address: cfg.treasuryAddress || null }));

  app.post('/sign', async (req, res) => {
    const body = JSON.stringify(req.body || {});
    const auth = verifySignerRequest({
      method: 'POST', path: '/sign',
      timestamp: req.headers['x-signer-timestamp'], nonce: req.headers['x-signer-nonce'],
      body, signature: req.headers['x-signer-signature'], secret: cfg.apiSecret, seenNonces,
    });
    if (!auth.ok) { audit({ event: 'sign.auth_failed', error: auth.error }); return res.status(401).json({ error: { message: auth.error } }); }
    try {
      const bodyObj = req.body || {};
      let wallet;
      if (bodyObj.kind === 'sweep') wallet = await keyProvider.getDepositWallet(bodyObj.deposit_index);
      else if (bodyObj.kind === 'withdrawal') wallet = await keyProvider.getTreasuryWallet();
      else return res.status(400).json({ error: { message: 'kind must be sweep or withdrawal' } });
      const result = await signJob({ req: bodyObj, wallet, cfg, provider, state, audit });
      return res.json({ result });
    } catch (e) {
      audit({ event: 'sign.failed', job_id: req.body?.job_id || null, error: e.message });
      return res.status(400).json({ error: { message: e.message } });
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: { message: 'Internal error' } }); });
  return app;
}

module.exports = { createSignerApp };
