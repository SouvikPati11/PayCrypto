'use strict';
// PayCrypto server entry. One Node app + MySQL + cron (scripts/monitor.js).
// No permanently running worker is required on Hostinger shared hosting.
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./src/lib/config');
const { createStore } = require('./src/lib/store');
const { verifySession } = require('./src/lib/auth');
const { deriveAddressFromXpub } = require('./src/lib/wallet');
const { pages, payPage } = require('./src/views');

const store = createStore();
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));

// Session from httpOnly cookie (dashboards). API keys are handled in api-v1.
app.use((req, res, next) => {
  const token = req.cookies?.paycrypto_session;
  if (token) { const sess = verifySession(token); if (sess) { req.user = sess; } }
  next();
});

// HD deriver: watch-only xpub from settings, if the operator set it.
// Private keys are never loaded by the web process in this design.
async function initDeriver() {
  try {
    const xpub = await store.getSetting('wallet_xpub');
    if (xpub) store.setAddressDeriver((index) => deriveAddressFromXpub(xpub, index));
  } catch (e) { console.warn('HD deriver not initialized:', e.message); }
}

app.get('/health', (req, res) => res.json({ ok: true, network: config.network, chain_id: config.chainId, payments_live: config.paymentsLive, emergency_pause: config.emergencyPause }));
app.get('/', (req, res) => res.send(pages.home()));
app.get('/features', (req, res) => res.send(pages.features()));
app.get('/pricing', (req, res) => res.send(pages.pricing()));
app.get('/about', (req, res) => res.send(pages.about()));
app.get('/contact', (req, res) => res.send(pages.contact()));
app.get('/faq', (req, res) => res.send(pages.faq()));
app.get('/docs', (req, res) => res.send(pages.docs()));
app.get('/api-docs', (req, res) => res.send(pages.apiDocs()));
app.get('/terms', (req, res) => res.send(pages.terms()));
app.get('/privacy', (req, res) => res.send(pages.privacy()));
app.get('/login', (req, res) => res.send(pages.login()));
app.get('/register', (req, res) => res.send(pages.register()));
app.get('/merchant', (req, res) => res.send(pages.merchant()));
app.get('/admin', (req, res) => res.send(pages.admin()));
app.get('/pay/:reference', async (req, res) => {
  const inv = await store.getInvoiceByReference(req.params.reference);
  if (!inv) return res.status(404).send(payPage(null));
  const withAmount = { ...inv, amount_usdt: require('./src/lib/money').formatUsdt(BigInt(inv.amount_base_units)) };
  return res.send(payPage(withAmount));
});

app.use('/api/auth', require('./src/routes/auth')(store));
app.use('/api/v1', require('./src/routes/api-v1')(store));
app.use('/api/admin', require('./src/routes/admin')(store));

// Cron-compatible monitor trigger (protected by header in production setups;
// Hostinger cron should call scripts/monitor.js directly instead).
app.post('/cron/monitor', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(403).json({ error: { message: 'Forbidden' } });
  return res.json({ ok: true, note: 'Use scripts/monitor.js from cron for resumable scanning. This endpoint only confirms the app is up.' });
});

app.use((req, res) => res.status(404).json({ error: { message: 'Not found' } }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: { message: 'Internal error' } }); });

if (require.main === module) {
  initDeriver().finally(() => {
    app.listen(config.port, () => console.log(`PayCrypto listening on ${config.port} (${config.network}, chain ${config.chainId}, live=${config.paymentsLive})`));
  });
}
module.exports = { app, store };
