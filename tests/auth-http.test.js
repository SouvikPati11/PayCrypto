'use strict';
// HTTP-level Super Admin authentication tests.
//
// Runs the real Express app (MemoryStore) on an ephemeral port and drives
// it with fetch, exactly like a browser: login, session cookie, CSRF,
// admin RBAC, logout, refresh, and the super_admin recovery endpoint.
// This file runs in its own process (node --test runs each file
// separately), so MEMORY_DB=true here cannot affect other test files.
//
// The recovery rate limiter (10 attempts / 15 min / IP) is shared by all
// recovery tests in this file, so the 429 test MUST stay last and the
// total number of recovery attempts before it must stay below 10.
process.env.MEMORY_DB = 'true';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { app, store } = require('../server/app');
const config = require('../server/src/lib/config');
const { hashPassword } = require('../server/src/lib/auth');

const ADMIN_EMAIL = 'souvikpati22@gmail.com';
const ADMIN_PASSWORD = 'Admin-Pass-42';
const SPACED_PASSWORD = ' Space-Pass-42 ';
const RECOVERY_CODE = 'recovery-code-0123456789abcdef';

let base;
let server;

function parseCookies(res) {
  const out = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function req(path, { method = 'GET', body, cookies, csrf } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookies) headers.Cookie = cookieHeader(cookies);
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookies: parseCookies(res) };
}
async function loginAs(email, password) {
  const r = await req('/api/auth/login', { method: 'POST', body: { email, password } });
  return r;
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.on('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  // Seed the users the tests log in as (same shape as scripts/seed-admin.js).
  await store.createUser({ email: ADMIN_EMAIL, password_hash: await hashPassword(ADMIN_PASSWORD), role: 'super_admin', merchant_id: null });
  const merchantUser = await store.createUser({ email: 'merchant@example.com', password_hash: await hashPassword('Merchant-Pass-42'), role: 'merchant', merchant_id: null });
  await store.createMerchant({ user_id: merchantUser.id, business_name: 'Test Shop', contact_email: 'merchant@example.com', status: 'approved' });
  await store.updateUser(merchantUser.id, { merchant_id: (await store.listMerchants())[0].id });
  // createUser always starts as active (schema default); suspend via update.
  const suspended = await store.createUser({ email: 'suspended-admin@example.com', password_hash: await hashPassword('Suspended-Pass-42'), role: 'super_admin', merchant_id: null });
  await store.updateUser(suspended.id, { status: 'suspended' });
  await store.createUser({ email: 'spaced@example.com', password_hash: await hashPassword(SPACED_PASSWORD), role: 'super_admin', merchant_id: null });
});

test.after(async () => { await new Promise((res) => server.close(res)); });

test('auth http: valid super_admin login returns role and session; admin overview answers', async () => {
  const r = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'super_admin');
  assert.equal(r.data.user.email, ADMIN_EMAIL);
  assert.ok(r.cookies.paycrypto_session, 'session cookie is set');
  assert.ok(r.cookies.paycrypto_csrf, 'csrf cookie is set');
  const ov = await req('/api/admin/overview', { cookies: r.cookies });
  assert.equal(ov.status, 200);
  assert.equal(ov.data.total_merchants, 1);
});

test('auth http: invalid password, unknown email and suspended account all return the same generic 401', async () => {
  for (const [email, password] of [
    [ADMIN_EMAIL, 'Wrong-Password-99'],
    ['nobody@example.com', 'Whatever-Pass-42'],
    ['suspended-admin@example.com', 'Suspended-Pass-42'],
  ]) {
    const r = await loginAs(email, password);
    assert.equal(r.status, 401);
    assert.equal(r.data.error.message, 'Invalid credentials');
  }
});

test('auth http: email is normalised at login (case and surrounding spaces)', async () => {
  const r = await loginAs('  SOUVIKPATI22@GMAIL.COM  ', ADMIN_PASSWORD);
  assert.equal(r.status, 200, 'MemoryStore is exact-match, so this proves the route normalises');
  assert.equal(r.data.user.email, ADMIN_EMAIL);
});

test('auth http: password is used exactly as typed, never trimmed', async () => {
  const trimmed = await loginAs('spaced@example.com', 'Space-Pass-42');
  assert.equal(trimmed.status, 401, 'the password without its spaces must not work');
  const exact = await loginAs('spaced@example.com', SPACED_PASSWORD);
  assert.equal(exact.status, 200, 'the password with its spaces must work');
});

test('auth http: merchant cannot reach admin routes; no session cannot either', async () => {
  const m = await loginAs('merchant@example.com', 'Merchant-Pass-42');
  assert.equal(m.status, 200);
  const denied = await req('/api/admin/overview', { cookies: m.cookies });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.message, 'Admin access required');
  const anon = await req('/api/admin/overview');
  assert.equal(anon.status, 403);
  // And a merchant is never sent to the admin dashboard by login: the
  // role in the login response is what the frontend routes on.
  assert.equal(m.data.user.role, 'merchant');
});

test('auth http: expired and invalid JWTs are rejected on admin routes', async () => {
  const expired = jwt.sign({ sub: 1, role: 'super_admin', merchantId: null, jti: 'expired-jti' }, config.jwtSecret, { expiresIn: '-1s' });
  const r1 = await req('/api/admin/overview', { cookies: { paycrypto_session: expired } });
  assert.equal(r1.status, 403);
  const r2 = await req('/api/admin/overview', { cookies: { paycrypto_session: 'not-a-token' } });
  assert.equal(r2.status, 403);
});

test('auth http: logout revokes the session; the same cookie then fails', async () => {
  const r = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(r.status, 200);
  const before = await req('/api/admin/overview', { cookies: r.cookies });
  assert.equal(before.status, 200);
  const out = await req('/api/auth/logout', { method: 'POST', cookies: r.cookies, csrf: r.cookies.paycrypto_csrf });
  assert.equal(out.status, 200);
  const after = await req('/api/admin/overview', { cookies: r.cookies });
  assert.equal(after.status, 403, 'revoked session must not reach admin routes');
  // findSessionByTokenHash returns null for a revoked row, so the 403
  // above is itself the proof the session was revoked server-side.
});

test('auth http: page refresh keeps the session (same cookie answers twice)', async () => {
  const r = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(r.status, 200);
  for (let i = 0; i < 2; i++) {
    const ov = await req('/api/admin/overview', { cookies: r.cookies });
    assert.equal(ov.status, 200, `refresh ${i + 1} must still be authenticated`);
  }
});

test('auth http: login page links the recovery page; recovery page renders', async () => {
  const loginPage = await fetch(base + '/login');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /admin-recover/);
  const recoverPage = await fetch(base + '/admin-recover');
  assert.equal(recoverPage.status, 200);
  assert.match(await recoverPage.text(), /Admin Password Recovery/);
});

test('auth http: recovery refuses when no code is configured, and when the code is too short', async () => {
  delete process.env.ADMIN_RECOVERY_CODE;
  const unset = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: 'anything', new_password: 'New-Admin-Pass-42' } });
  assert.equal(unset.status, 503);
  process.env.ADMIN_RECOVERY_CODE = 'too-short';
  const short = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: 'too-short', new_password: 'New-Admin-Pass-42' } });
  assert.equal(short.status, 503);
});

test('auth http: recovery with a wrong code, a merchant email, or a weak password fails generically', async () => {
  process.env.ADMIN_RECOVERY_CODE = RECOVERY_CODE;
  const wrongCode = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: 'wrong-code-0123456789', new_password: 'New-Admin-Pass-42' } });
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.data.error.message, 'Invalid recovery details');
  const merchant = await req('/api/auth/admin-recover', { method: 'POST', body: { email: 'merchant@example.com', recovery_code: RECOVERY_CODE, new_password: 'New-Admin-Pass-42' } });
  assert.equal(merchant.status, 401, 'a merchant must not be resettable through this endpoint');
  assert.equal(merchant.data.error.message, 'Invalid recovery details');
  const weak = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: RECOVERY_CODE, new_password: 'short' } });
  assert.equal(weak.status, 400);
});

test('auth http: recovery with the correct code resets the password, revokes old sessions, and the new password logs in', async () => {
  process.env.ADMIN_RECOVERY_CODE = RECOVERY_CODE;
  const oldLogin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(oldLogin.status, 200);
  const r = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: RECOVERY_CODE, new_password: 'New-Admin-Pass-42' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const oldStillWorks = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(oldStillWorks.status, 401, 'old password must stop working immediately');
  const newWorks = await loginAs(ADMIN_EMAIL, 'New-Admin-Pass-42');
  assert.equal(newWorks.status, 200, 'new password must log in');
  assert.equal(newWorks.data.user.role, 'super_admin');
  const oldSession = await req('/api/admin/overview', { cookies: oldLogin.cookies });
  assert.equal(oldSession.status, 403, 'sessions from before the reset are revoked');
  const samePassword = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: RECOVERY_CODE, new_password: 'New-Admin-Pass-42' } });
  assert.equal(samePassword.status, 400, 'resetting to the current password is refused');
});

// LAST recovery test: it exhausts the 10-attempt rate-limit budget.
test('auth http: recovery rate-limits after 10 attempts in 15 minutes', async () => {
  process.env.ADMIN_RECOVERY_CODE = RECOVERY_CODE;
  // Attempts so far in this file: wrong code (1), merchant (1), weak (1),
  // success (1), same-password (1) = 5. Five more wrong attempts reach 10.
  for (let i = 0; i < 5; i++) {
    const r = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: 'wrong-code-0123456789', new_password: 'New-Admin-Pass-42' } });
    assert.equal(r.status, 401);
  }
  const blocked = await req('/api/auth/admin-recover', { method: 'POST', body: { email: ADMIN_EMAIL, recovery_code: 'wrong-code-0123456789', new_password: 'New-Admin-Pass-42' } });
  assert.equal(blocked.status, 429);
});
