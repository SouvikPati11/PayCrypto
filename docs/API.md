# Merchant API — v1

Base: `/api/v1` · Version in the path (`/api/v1/...`).

## Authentication

- `Authorization: Bearer pk_test_…` or `pk_live_…` (shown once at
  creation, stored only as SHA-256).
- Dashboard sessions use an httpOnly cookie and are equivalent for
  merchant-scoped endpoints.
- A merchant can only access their own merchant_id. Cross-merchant
  access returns 404, not a leak.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/invoices` | Body: `{amount, customerEmail?, metadata?}`. Header `Idempotency-Key` returns the original invoice on retry. |
| GET | `/api/v1/invoices` | `?status=` filter |
| GET | `/api/v1/invoices/:id` | Merchant-scoped |
| GET | `/api/v1/invoices/:reference/public` | Public pay-page status, limited fields, no auth |
| GET | `/api/v1/transactions` | Merchant blockchain transactions |
| GET | `/api/v1/balance` | Derived from ledger: `{available_usdt, derived_from_ledger:true}` |
| POST | `/api/v1/withdrawals` | `{destination, amount}` — BSC address validated, limits + fee applied, admin approval required |
| GET | `/api/v1/withdrawals/:id` | Status |
| POST | `/api/v1/api-keys` | Returns `plaintext` once |
| POST | `/api/v1/api-keys/:id/revoke` | |
| POST | `/api/v1/webhooks` | Body `{url (https), events?}` — returns `secret` once |
| GET | `/api/v1/webhooks`, `/api/v1/webhook-logs` | |

## Errors

Structured: `{error:{message}}` with HTTP status (400 validation,
401 auth, 403 approval/permission, 404 not found, 409 duplicate,
503 paused). Never trust a frontend payment status.

## Webhooks

- Event: `invoice.paid` (payload: invoice_id, tx_hash, amount).
- Header: `X-PayCrypto-Signature: sha256=<hmac-sha256(secret, raw-body)>`
- Verify with a timing-safe compare. Retry schedule (queued by the
  monitor): 1m, 5m, 15m, 1h, 6h, max 5 attempts.
- Production delivery worker (implemented, Phase 2):
  `scripts/deliver-webhooks.js`, cron every minute (see
  docs/DEPLOYMENT_CHECKLIST.md). It POSTs `pending` logs whose
  `next_retry_at` has passed, updates `webhook_logs` with the
  response code, and marks `sent`/`failed` after the final
  (5th) attempt. The monitor only queues; it does not block
  scanning on a slow merchant endpoint. Webhook log listings
  via the API strip the HMAC signature (Phase 2).

## Rate limits

600 requests / 15 min per IP on `/api/*`, 30 / 15 min on login,
**plus** 600 requests / 15 min per merchant/API key on
authenticated `/api/v1/*` routes (Phase 2, in-memory per-process
store — see the limitation note in `server/src/lib/rate-limit.js`
for multi-process deployments).
