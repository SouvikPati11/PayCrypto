'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const config = require('./config');

async function hashPassword(password) { return bcrypt.hash(password, 12); }
async function verifyPassword(password, hash) { return bcrypt.compare(password, hash); }

function signSession(user) {
  // jti links the JWT to a login_sessions row so logout can revoke it
  // (PHASE 1). A bare JWT with no server-side record could not be revoked.
  const jti = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ sub: user.id, role: user.role, merchantId: user.merchant_id || null, jti }, config.jwtSecret, { expiresIn: '24h' });
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function verifySession(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch { return null; }
}

// API keys: plaintext shown ONCE at creation, only a SHA-256 hash is stored.
// Prefix distinguishes test/live so a test key can never be mistaken for live.
function generateApiKey(live = false) {
  const secret = crypto.randomBytes(32).toString('hex');
  const prefix = live ? 'pk_live_' : 'pk_test_';
  const plaintext = prefix + secret;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash, prefix };
}
function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function newTotpSecret() { return authenticator.generateSecret(); }
function totpToken(secret) { return authenticator.generate(secret); }
function verifyTotp(token, secret) {
  try { return authenticator.check(String(token), secret); } catch { return false; }
}
function totpAuthUrl(secret, email) {
  return authenticator.keyuri(email, 'PayCrypto', secret);
}

const ADMIN_PERMISSIONS = {
  super_admin: ['*'],
  admin: ['merchants:read', 'merchants:manage', 'invoices:read', 'withdrawals:approve', 'wallets:read', 'sweeps:manage', 'api:read', 'settings:read', 'audit:read'],
  support: ['merchants:read', 'invoices:read', 'audit:read'],
};
function can(role, permission) {
  const perms = ADMIN_PERMISSIONS[role] || [];
  return perms.includes('*') || perms.includes(permission);
}

module.exports = { hashPassword, verifyPassword, signSession, verifySession, tokenHash, generateApiKey, hashApiKey, newTotpSecret, totpToken, verifyTotp, totpAuthUrl, ADMIN_PERMISSIONS, can };
