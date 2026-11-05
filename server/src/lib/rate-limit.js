'use strict';
// Per-API-key / per-merchant rate limiting (in-memory, sliding window).
// This is in ADDITION to the IP-based express-rate-limit in server/index.js:
// IP limits alone do not stop one merchant (or one shared Hostinger proxy
// IP) from consuming another merchant's fair share, and they do not
// distinguish API keys at all.
// Limitation, stated plainly: this store is per-process. On a single
// Hostinger Node process that is the whole deployment; on a multi-process
// VPS deployment it must be replaced with a shared store (Redis) — see
// docs/API.md. It never replaces the IP limiter.
function createPerKeyLimiter({ windowMs = 15 * 60 * 1000, max = 600 } = {}) {
  const hits = new Map(); // key -> array of timestamps
  function middleware(req, res, next) {
    const key = req.merchantId ? `merchant:${req.merchantId}` : `ip:${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (list.length > max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: { message: 'Too many requests for this merchant/API key. Try again later.' } });
    }
    return next();
  }
  middleware._hits = hits;
  return middleware;
}
module.exports = { createPerKeyLimiter };
