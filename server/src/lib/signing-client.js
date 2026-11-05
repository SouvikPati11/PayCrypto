'use strict';
// Backend -> signer client. Used ONLY by operator scripts
// (scripts/request-sweep.js, scripts/request-withdrawal.js), never by
// web routes and never automatically by cron. The signer secret is an
// HMAC secret, not a signing key — it authorises a request, it cannot
// sign a transaction by itself, and the signer still enforces chain,
// contract, destination, gas, limits, nonce and job-id checks.
const crypto = require('node:crypto');
const { hmacSign } = require('../../services/signer/core');

async function requestSigning({ signerUrl, apiSecret, body }) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const raw = JSON.stringify(body);
  const signature = hmacSign(apiSecret, 'POST', '/sign', timestamp, nonce, raw);
  const res = await fetch(`${signerUrl.replace(/\/$/, '')}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signer-Timestamp': timestamp, 'X-Signer-Nonce': nonce, 'X-Signer-Signature': signature },
    body: raw,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Signer rejected request: ${data.error?.message || res.status}`);
  if (!data.result?.tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(data.result.tx_hash)) throw new Error('Signer returned an invalid transaction hash');
  return data.result;
}

module.exports = { requestSigning };
