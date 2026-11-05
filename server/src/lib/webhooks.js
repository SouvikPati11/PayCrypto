'use strict';
// Webhook HMAC signing (SHA-256) + retry schedule. Payloads are signed with
// the merchant's webhook secret; receivers must verify the signature and
// must not trust an unsigned payload.
const crypto = require('node:crypto');

function signWebhook(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
function verifyWebhook(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = signWebhook(secret, rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}
// Exponential backoff: 1m, 5m, 15m, 1h, 6h — max 5 attempts total.
function nextRetryDelayMs(attempt) {
  const delays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}
module.exports = { signWebhook, verifyWebhook, nextRetryDelayMs };
