'use strict';
// Webhook delivery worker logic (used by scripts/deliver-webhooks.js).
// Delivery status is real, not assumed: every attempt updates webhook_logs
// with attempts, response_code and next_retry_at. After 5 attempts the
// log is marked failed and is no longer retried — the merchant must
// re-check their endpoint, not wait forever.
// Payloads are already HMAC-signed at queue time (scripts/monitor.js),
// so the worker never needs the webhook secret.
const { nextRetryDelayMs } = require('./webhooks');

async function deliverOne(store, log, fetchFn) {
  const payload = typeof log.payload === 'string' ? log.payload : JSON.stringify(log.payload);
  const attempts = (log.attempts || 0) + 1;
  try {
    // URL is set by the worker (from the webhook row) before calling
    // this function, so delivery never needs the webhook secret here.
    const url = log.url;
    if (!url) throw new Error('Webhook URL not available for this log');
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PayCrypto-Signature': log.signature || '', 'X-PayCrypto-Event': log.event || '' },
      body: payload,
    });
    const ok = res.status >= 200 && res.status < 300;
    if (ok) {
      await store.updateWebhookLog(log.id, { status: 'sent', attempts, response_code: res.status });
      return { delivered: true, attempts, response_code: res.status };
    }
    if (attempts >= 5) {
      await store.updateWebhookLog(log.id, { status: 'failed', attempts, response_code: res.status });
      return { delivered: false, attempts, response_code: res.status, failed: true };
    }
    await store.updateWebhookLog(log.id, { status: 'pending', attempts, response_code: res.status, next_retry_at: new Date(Date.now() + nextRetryDelayMs(attempts)).toISOString() });
    return { delivered: false, attempts, response_code: res.status };
  } catch (e) {
    if (attempts >= 5) {
      await store.updateWebhookLog(log.id, { status: 'failed', attempts });
      return { delivered: false, attempts, failed: true, error: e.message };
    }
    await store.updateWebhookLog(log.id, { status: 'pending', attempts, next_retry_at: new Date(Date.now() + nextRetryDelayMs(attempts)).toISOString() });
    return { delivered: false, attempts, error: e.message };
  }
}

module.exports = { deliverOne };
