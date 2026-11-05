'use strict';
// Webhook delivery worker — cron every 1 minute on Hostinger:
//   * * * * * cd ~/paycrypto && /usr/bin/node scripts/deliver-webhooks.js >> logs/webhooks.log 2>&1
// Picks up pending logs queued by scripts/monitor.js, POSTs them with
// their pre-computed HMAC signature, and updates delivery status.
// After 5 attempts a log is marked failed and stops retrying.
// This worker never sees webhook secrets (signatures are pre-computed).
const { createStore } = require('../server/src/lib/store');
const { deliverOne } = require('../server/src/lib/webhook-delivery');

async function main() {
  const store = createStore();
  const due = await store.listDueWebhookLogs();
  console.log(`Webhook delivery: ${due.length} due log(s)`);
  for (const log of due) {
    const wh = await store.getWebhookById(log.webhook_id);
    if (!wh || !wh.active) {
      await store.updateWebhookLog(log.id, { status: 'failed', attempts: (log.attempts || 0) + 1 });
      console.log(`Log ${log.id}: webhook inactive/missing, marked failed`);
      continue;
    }
    const result = await deliverOne(store, { ...log, url: wh.url }, fetch);
    console.log(`Log ${log.id}:`, result);
  }
}
if (require.main === module) main().catch((e) => { console.error('Webhook delivery failed:', e.message); process.exitCode = 1; });
module.exports = { main };
