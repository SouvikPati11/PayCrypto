'use strict';
// Double-submit CSRF defence for session-cookie authentication.
// API-key (Bearer) requests are NOT ambient credentials, so they are exempt:
// a cross-site page cannot read the merchant's API key to send it.
// Session requests must send X-CSRF-Token equal to the paycrypto_csrf cookie
// value set at login. SameSite=Lax on the session cookie is a second layer,
// not a replacement for this check.
const crypto = require('node:crypto');

function generateCsrfToken() { return crypto.randomBytes(32).toString('hex'); }

function verifyCsrf(req) {
  const cookie = req.cookies?.paycrypto_csrf;
  const header = req.headers?.['x-csrf-token'];
  if (!cookie || !header || typeof header !== 'string') return false;
  try { return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header)); } catch { return false; }
}

function csrfRequired(req) {
  if (!req.user) return false; // no session, nothing ambient to protect
  if (req.headers?.authorization?.startsWith('Bearer ')) return false; // API-key auth
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  return true;
}

module.exports = { generateCsrfToken, verifyCsrf, csrfRequired };
