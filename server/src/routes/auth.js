'use strict';
const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { normalizeEmail, hashPassword, verifyPassword, signSession, verifyTotp, newTotpSecret, totpAuthUrl, tokenHash } = require('../lib/auth');
const { generateCsrfToken } = require('../lib/csrf');
const { encryptSecret } = require('../lib/wallet');
const config = require('../lib/config');
const { isDbError } = require('../lib/db-error');

function router(store) {
  const r = express.Router();
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', maxAge: 24 * 3600 * 1000, path: '/' };

  r.post('/register', async (req, res) => {
    try {
      const { businessName, website } = req.body || {};
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      if (!businessName || !email || !password) return res.status(400).json({ error: { message: 'businessName, email and password are required' } });
      if (String(password).length < 10) return res.status(400).json({ error: { message: 'Password must be at least 10 characters' } });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: { message: 'Invalid email' } });
      const user = await store.createUser({ email, password_hash: await hashPassword(password), role: 'merchant', merchant_id: null });
      const merchant = await store.createMerchant({ user_id: user.id, business_name: businessName, contact_email: email, website: website || null, status: 'pending' });
      await store.updateUser(user.id, { merchant_id: merchant.id });
      await store.logAudit({ actor_type: 'merchant', actor_id: user.id, action: 'merchant.registered', entity_type: 'merchant', entity_id: merchant.id, ip_address: req.ip });
      return res.status(201).json({ user: { id: user.id, email, role: 'merchant' }, merchant: { id: merchant.id, status: 'pending' } });
    } catch (e) { return res.status(e.code === 'DUPLICATE' ? 409 : isDbError(e) ? 503 : 500).json({ error: { message: isDbError(e) ? 'Database unavailable' : e.message } }); }
  });

  r.post('/login', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      // Password is used exactly as received — never trimmed or altered.
      // (A password with a leading/trailing space is a different password.)
      const { password, totp } = req.body || {};
      if (!email || !password) return res.status(401).json({ error: { message: 'Invalid credentials' } });
      const user = await store.findUserByEmail(email);
      if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: { message: 'Invalid credentials' } });
      }
      if (user.totp_enabled) {
        if (!totp) return res.status(401).json({ error: { message: 'Two-factor code required', totp_required: true } });
        const secret = require('../lib/wallet').decryptSecret(user.totp_secret_encrypted);
        if (!verifyTotp(totp, secret)) return res.status(401).json({ error: { message: 'Invalid two-factor code' } });
      }
      await store.logAudit({ actor_type: user.role, actor_id: user.id, action: 'user.login', entity_type: 'user', entity_id: user.id, ip_address: req.ip });
      const token = signSession(user);
      // PHASE 1: server-side session record so logout revokes the JWT.
      await store.createSession({ user_id: user.id, token_hash: tokenHash(token), ip_address: req.ip || null, user_agent: req.headers['user-agent'] || null, expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
      const csrf = generateCsrfToken();
      res.cookie('paycrypto_session', token, cookieOpts);
      res.cookie('paycrypto_csrf', csrf, { sameSite: 'lax', secure: config.env === 'production', maxAge: 24 * 3600 * 1000, path: '/' });
      return res.json({ user: { id: user.id, email: user.email, role: user.role, merchant_id: user.merchant_id }, csrf_token: csrf });
    } catch (e) { return res.status(isDbError(e) ? 503 : 500).json({ error: { message: isDbError(e) ? 'Database unavailable' : e.message } }); }
  });

  // Super-admin password recovery (break-glass, no SSH/terminal needed).
  // Gated by ADMIN_RECOVERY_CODE, a long random string the site owner sets
  // privately in hPanel > Node.js app > Environment Variables and restarts
  // the app to activate. The code is never stored in the repo, never
  // logged, and compared by hash (timing-safe). The endpoint:
  //   - refuses (503) unless a code of >= 20 chars is configured;
  //   - rate-limits guesses (10 per 15 min per IP);
  //   - answers every failure with the same generic 401, so it cannot
  //     be used to tell whether an email exists or which role it has;
  //   - only resets a super_admin account, never a merchant;
  //   - revokes every session for that user, audit-logs the reset, and
  //     does NOT log the user in — they must log in with the new password.
  // Remove/rotate ADMIN_RECOVERY_CODE in hPanel after use.
  // See docs/ADMIN_RECOVERY.md for the exact owner procedure.
  const recoveryConfigured = (req, res, next) => {
    const code = process.env.ADMIN_RECOVERY_CODE || '';
    if (code.length < 20) return res.status(503).json({ error: { message: 'Admin recovery is not configured' } });
    return next();
  };
  const recoveryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
  r.post('/admin-recover', recoveryConfigured, recoveryLimiter, async (req, res) => {
    try {
      const code = process.env.ADMIN_RECOVERY_CODE || '';
      const supplied = String(req.body?.recovery_code || '');
      const newPassword = req.body?.new_password;
      const email = normalizeEmail(req.body?.email);
      const match = crypto.timingSafeEqual(
        crypto.createHash('sha256').update(supplied).digest(),
        crypto.createHash('sha256').update(code).digest()
      );
      if (!match) return res.status(401).json({ error: { message: 'Invalid recovery details' } });
      if (!email || typeof newPassword !== 'string' || newPassword.length < 10) {
        return res.status(400).json({ error: { message: 'A valid email and a new password of at least 10 characters are required' } });
      }
      const user = await store.findUserByEmail(email);
      if (!user || user.role !== 'super_admin') return res.status(401).json({ error: { message: 'Invalid recovery details' } });
      if (await verifyPassword(newPassword, user.password_hash)) {
        return res.status(400).json({ error: { message: 'The new password must be different from the current password' } });
      }
      await store.updateUser(user.id, { password_hash: await hashPassword(newPassword) });
      await store.revokeSessionsByUserId(user.id);
      await store.logAudit({ actor_type: 'super_admin', actor_id: user.id, action: 'admin.password_recovered', entity_type: 'user', entity_id: user.id, ip_address: req.ip });
      return res.json({ ok: true, message: 'Admin password reset. Log in at /login with the new password, then remove the recovery code from the app environment variables.' });
    } catch (e) { return res.status(isDbError(e) ? 503 : 500).json({ error: { message: isDbError(e) ? 'Database unavailable' : 'Recovery failed' } }); }
  });

  r.post('/logout', async (req, res) => {
    const token = req.cookies?.paycrypto_session;
    if (token) { try { await store.revokeSessionByTokenHash(tokenHash(token)); } catch {} }
    res.clearCookie('paycrypto_session', { path: '/' });
    res.clearCookie('paycrypto_csrf', { path: '/' });
    return res.json({ ok: true });
  });

  // Authenticated helpers: session middleware is attached in index.js and
  // populates req.user; these routes just use it.
  r.post('/totp/setup', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: { message: 'Login required' } });
    const user = await store.findUserById(req.user.sub);
    const secret = newTotpSecret();
    await store.updateUser(req.user.sub, { totp_secret_encrypted: encryptSecret(secret) });
    return res.json({ otpauth_url: totpAuthUrl(secret, user?.email || 'user'), note: 'Scan with an authenticator app, then confirm with POST /api/auth/totp/enable and a code.' });
  });
  r.post('/totp/enable', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: { message: 'Login required' } });
    const user = await store.findUserById(req.user.sub);
    if (!user?.totp_secret_encrypted) return res.status(400).json({ error: { message: 'Run totp/setup first' } });
    const secret = require('../lib/wallet').decryptSecret(user.totp_secret_encrypted);
    if (!verifyTotp(req.body?.totp, secret)) return res.status(400).json({ error: { message: 'Invalid code' } });
    await store.updateUser(user.id, { totp_enabled: true });
    return res.json({ ok: true });
  });
  return r;
}
module.exports = router;
