'use strict';
// PayCrypto server entry. One Node app + MySQL + cron (scripts/monitor.js).
// No permanently running worker is required on Hostinger shared hosting.
//
// App construction module (HOSTINGER STARTUP FIX, 2026-11-05).
// Importing this module does NOT start a server. That is deliberate:
// tests import this module, and the production entry point
// server/index.js calls startServer() unconditionally.
// HOSTINGER STARTUP FIX (2026-11-05):
// Previously, `initDeriver()` awaited a MySQL query BEFORE `app.listen()`,
// so a slow or unavailable MySQL could delay the HTTP listener past
// Hostinger's 3-second limit ("App did not call listen() within
// 3 seconds") and the app never started at all.
// Now the order is strictly:
//   1. Build the app (synchronous, no I/O).
//   2. Call `app.listen()` IMMEDIATELY on the Hostinger PORT.
//   3. Only AFTER the listener is up, check the database and initialise
//      the HD deriver asynchronously, in the background, with retries.
//      A deriver/DB failure is logged and reported by /health and /ready,
//      but it never crashes the HTTP server and never blocks startup.
// No other behaviour is changed: gates, CSP, CSRF, sessions and routes
// are exactly as before.
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./src/lib/config');
const { createStore } = require('./src/lib/store');
const { verifySession, tokenHash } = require('./src/lib/auth');
const { verifyCsrf, csrfRequired } = require('./src/lib/csrf');
const { deriveAddressFromXpub } = require('./src/lib/wallet');
const { isDbError, sanitizeDbError } = require('./src/lib/db-error');
const { dbConfigDiagnostics, dotenvStatus } = require('./src/lib/db-diagnostics');
const { pages, payPage } = require('./src/views');

const STARTED_AT = Date.now();
const store = createStore();
const app = express();

// Readiness state — the single source of truth for /health and /ready.
// db: 'unknown' (not yet checked) | 'ready' | 'unavailable'
// deriver: 'pending' | 'ready' | 'not_configured' | 'failed'
// lastError holds only an error CODE (e.g. ECONNREFUSED), never a
// credential, connection string, password or full internal message.
const readiness = {
  db: 'unknown',
  deriver: 'pending',
  dbMode: config.memoryDb ? 'memory' : 'mysql',
  lastCheckedAt: null,
  lastError: null,
  // Sanitised DB failure detail (code/errno/sqlState/user@host only —
  // never a password or connection string) and the safe identity the
  // app attempted (host/port/user/database + password facts only).
  // This is what distinguishes "wrong user", "wrong password",
  // "user not granted from this host" and "unknown database" on
  // Hostinger, where the old code only kept the error code.
  dbError: null,
  dbConfig: dbConfigDiagnostics(config),
  dotenv: dotenvStatus(),
};

app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
  frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
} } }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));

// Session from httpOnly cookie, checked against the server-side
// login_sessions row. A JWT whose session was revoked (logout) no longer
// authenticates, even before its 24h expiry.
app.use(async (req, res, next) => {
  const token = req.cookies?.paycrypto_session;
  if (token) {
    const sess = verifySession(token);
    if (sess) {
      try {
        const row = await store.findSessionByTokenHash(tokenHash(token));
        if (row) req.user = sess;
      } catch (e) {
        console.warn('Session check failed, treating as unauthenticated:', e.code || 'DB_ERROR');
      }
    }
  }
  next();
});

// CSRF check for session-authenticated state changes.
// Bearer API-key requests are exempt (not ambient credentials).
app.use((req, res, next) => {
  if (csrfRequired(req) && !verifyCsrf(req)) {
    return res.status(403).json({ error: { message: 'CSRF token missing or invalid' } });
  }
  next();
});

// HD deriver: watch-only xpub from settings, if the operator set it.
// Private keys are never loaded by the web process in this design.
// This function is NEVER awaited before listen() — see checkReadiness().
async function initDeriver() {
  const xpub = await store.getSetting('wallet_xpub');
  if (!xpub) { readiness.deriver = 'not_configured'; return false; }
  store.setAddressDeriver((index) => deriveAddressFromXpub(xpub, index));
  readiness.deriver = 'ready';
  return true;
}

// Background readiness check, run AFTER listen() and retried on failure.
// It never throws to the caller and never crashes the server.
async function checkReadiness() {
  try {
    await store.ping();
    readiness.db = 'ready';
    readiness.lastError = null;
  } catch (e) {
    readiness.db = 'unavailable';
    readiness.lastError = e.code || 'DB_ERROR';
    readiness.dbError = sanitizeDbError(e);
    readiness.deriver = 'failed';
    console.warn(`[startup] Database unavailable: ${JSON.stringify(readiness.dbError)}. Attempted: ${JSON.stringify(readiness.dbConfig)}. API routes will return 503 until it recovers; the HTTP server stays up.`);
    readiness.lastCheckedAt = new Date().toISOString();
    return readiness;
  }
  readiness.lastCheckedAt = new Date().toISOString();
  try {
    await initDeriver();
  } catch (e) {
    readiness.deriver = 'failed';
    readiness.lastError = e.code || 'DB_ERROR';
    readiness.dbError = sanitizeDbError(e);
    console.warn(`[startup] HD deriver failed: ${JSON.stringify(readiness.dbError)}. Invoice creation will fail until wallet_xpub is set and the database recovers.`);
  }
  return readiness;
}

// Retry readiness in the background if it is not yet ready. The timer
// is unref'd so it never keeps a test process alive on its own.
function scheduleReadinessRetry() {
  if (readiness.db === 'ready' && readiness.deriver !== 'failed') return;
  const t = setTimeout(() => { checkReadiness().finally(scheduleReadinessRetry); }, 30_000);
  if (typeof t.unref === 'function') t.unref();
}

function assertProductionSecrets() {
  // Synchronous, sub-millisecond checks only — these never block
  // listen() on a slow network, and they are intentional: a production
  // app with dev fallback secrets must not start at all.
  if (config.env !== 'production') return;
  const bad = [];
  if (!config.jwtSecret || config.jwtSecret.includes('dev-only') || config.jwtSecret.length < 32) bad.push('JWT_SECRET');
  if (!config.sessionSecret || config.sessionSecret.includes('dev-only') || config.sessionSecret.length < 32) bad.push('SESSION_SECRET');
  if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey || '')) bad.push('ENCRYPTION_KEY (must be 64 hex chars)');
  if (bad.length) {
    console.error('Refusing to start in production with weak/missing secrets:', bad.join(', '));
    process.exit(1);
  }
}

// Liveness: the app process is up. This endpoint NEVER claims the
// database is ready — it reports the actual readiness state, and
// returns status 'degraded' (still HTTP 200, so Hostinger and load
// balancers can see the process is alive) when the DB is down.
// Use /ready for a strict readiness gate.
app.get('/health', (req, res) => res.json({
  ok: true,
  status: readiness.db === 'ready' ? 'ready' : readiness.db === 'unavailable' ? 'degraded' : 'starting',
  db_ready: readiness.db === 'ready',
  db_mode: readiness.dbMode,
  db: readiness.db,
  deriver: readiness.deriver,
  last_error: readiness.lastError,
  db_error: readiness.dbError,
  db_config: readiness.dbConfig,
  dotenv: readiness.dotenv,
  last_checked_at: readiness.lastCheckedAt,
  network: config.network, chain_id: config.chainId,
  payments_live: config.paymentsLive, emergency_pause: config.emergencyPause,
}));

// Readiness: 200 only when the database is actually reachable.
// Hostinger / a load balancer should use this to decide whether the
// app can serve database-dependent traffic yet.
app.get('/ready', (req, res) => {
  if (readiness.db !== 'ready') {
    return res.status(503).json({ ok: false, db: readiness.db, deriver: readiness.deriver, last_error: readiness.lastError, db_error: readiness.dbError, db_config: readiness.dbConfig, message: 'Database unavailable' });
  }
  return res.json({ ok: true, db: readiness.db, deriver: readiness.deriver });
});

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
app.get('/admin-recover', (req, res) => res.send(pages.recover()));
app.get('/pay/:reference', async (req, res) => {
  try {
    const inv = await store.getInvoiceByReference(req.params.reference);
    if (!inv) return res.status(404).send(payPage(null));
    const withAmount = { ...inv, amount_usdt: require('./src/lib/money').formatUsdt(BigInt(inv.amount_base_units)) };
    return res.send(payPage(withAmount));
  } catch (e) {
    if (isDbError(e)) return res.status(503).send('<h1>Database unavailable</h1><p>Please try again shortly.</p>');
    throw e;
  }
});

// Database-dependent API routes: if the database is KNOWN unavailable
// (checked within the last 30 seconds), fail fast with 503 instead of
// waiting for another slow DB timeout on every request. If readiness
// is still 'unknown' (first seconds after startup), requests pass
// through and the route's own error handling applies.
app.use('/api/', (req, res, next) => {
  if (readiness.db === 'unavailable') {
    const age = readiness.lastCheckedAt ? Date.now() - new Date(readiness.lastCheckedAt).getTime() : Infinity;
    if (age < 30_000) return res.status(503).json({ error: { message: 'Database unavailable' } });
  }
  return next();
});

app.use('/api/auth', require('./src/routes/auth')(store));
app.use('/api/v1', require('./src/routes/api-v1')(store));
app.use('/api/admin', require('./src/routes/admin')(store));

app.post('/cron/monitor', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(403).json({ error: { message: 'Forbidden' } });
  return res.json({ ok: true, note: 'Use scripts/monitor.js from cron for resumable scanning. This endpoint only confirms the app is up.' });
});

app.use((req, res) => res.status(404).json({ error: { message: 'Not found' } }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (isDbError(err)) return res.status(503).json({ error: { message: 'Database unavailable' } });
  return res.status(500).json({ error: { message: 'Internal error' } });
});

// Safety net for async route handlers that throw after the DB goes
// down mid-request (Express 4 does not catch async rejections by
// itself). This keeps a single failed DB request from crashing the
// whole Hostinger app; the readiness check will mark the DB
// unavailable and subsequent API requests get a fast 503 instead.
process.on('unhandledRejection', (err) => {
  console.error('[startup] Unhandled rejection (server kept alive):', err && err.code ? err.code : (err && err.message) || err);
});

function startServer() {
  // Start only once per process. Require-cache normally guarantees this,
  // but Hostinger loaders may load the entry file in unusual ways, so
  // guard explicitly: a second call returns the existing server instead
  // of trying to listen again (which would fail with EADDRINUSE).
  if (globalThis.__paycryptoActiveServer) return globalThis.__paycryptoActiveServer;
  // Hostinger provides PORT; fall back to 3000 only if it is missing
  // or invalid, and say so in the log. Bind 0.0.0.0 explicitly so the
  // app is reachable on Hostinger's network, not only on localhost.
  const port = Number.isFinite(config.port) && config.port > 0 && config.port < 65536 ? config.port : 3000;
  if (port !== config.port) console.warn(`[startup] Invalid PORT '${process.env.PORT}', falling back to ${port}`);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[startup] PayCrypto listening on 0.0.0.0:${port} after ${Date.now() - STARTED_AT}ms (${config.network}, chain ${config.chainId}, live=${config.paymentsLive}, db_mode=${readiness.dbMode})`);
    // ONLY NOW, after listen(), start the database check + deriver.
    // This is deliberately not awaited by listen().
    checkReadiness().finally(scheduleReadinessRetry);
  });
  server.on('error', (err) => {
    console.error(`[startup] Failed to listen on port ${port}:`, err.code || err.message);
    process.exit(1);
  });
  server.on('close', () => { if (globalThis.__paycryptoActiveServer === server) globalThis.__paycryptoActiveServer = null; });
  globalThis.__paycryptoActiveServer = server;
  return server;
}

module.exports = { app, store, readiness, checkReadiness, initDeriver, startServer, assertProductionSecrets };
