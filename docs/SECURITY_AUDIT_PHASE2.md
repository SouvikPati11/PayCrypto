# Phase 2 — Documentation Verification + Residual-Risk Fixes (2026-11-05)

Base: `main` at `13fe05a`, Phase 1 audit + fixes already landed.
Gates stay OFF: `PAYMENTS_LIVE=false`, `AUTO_SWEEP=false`,
`WITHDRAWAL_AUTO_BROADCAST=false`. No breaking changes intended;
every change below was re-tested (see test report in the Phase 2
completion report).

## Documentation verified against code

- **Environment variables:** every `process.env.*` in `server/` and
  `scripts/` was listed and compared with `.env.example`. Two
  init-wallet-only variables (`WALLET_MNEMONIC`, `WALLET_OVERWRITE`)
  were missing from `.env.example` and are now documented there as
  optional, commented-out entries. No other variable was missing.
- **npm scripts:** `dev`, `start`, `test`, `migrate`, `seed`,
  `init-wallet`, `monitor` all exist and match the docs; Phase 2
  adds `deliver-webhooks`. `main` is `server/index.js`, `engines`
  is Node `>=20`.
- **Migrations:** `001_schema.sql` then `002_seed.sql`, in order.
  Table/column names in `server/src/lib/store.js` were checked
  against the schema (users, merchants, api_keys, deposit_addresses,
  invoices, blockchain_transactions, ledger_entries, withdrawals,
  sweep_jobs, webhooks, webhook_logs, audit_logs, system_settings,
  login_sessions, monitor_checkpoints). No mismatch found, except
  timestamp formatting (see below).
- **Hostinger instructions:** startup file, root `package.json`,
  MySQL-only, cron-not-daemon architecture, and cron commands were
  all re-checked against `server/index.js` and the scripts. The
  Phase 3 checklist (`docs/DEPLOYMENT_CHECKLIST.md`) is the
  corrected, step-by-step version.
- **CI workflow:** YAML parses, `permissions: contents: read`,
  no `secrets.*` in any `if:` condition, Node 20, `npm ci ||
  npm install`, then `npm test`. It is still not on GitHub for
  the Workflows-permission reason documented in
  `docs/CI_MANUAL_ADD.md` — that document, not a permission change,
  is the Phase 2 deliverable for CI.

## Residual risks fixed in Phase 2

1. **CSP (was: helmet CSP off, inline scripts everywhere).**
   All page JavaScript moved to external files under `public/js/`
   (`login.js`, `register.js`, `contact.js`, `merchant.js`,
   `admin.js`, `pay.js`); no inline `<script>` blocks, no `onclick`
   / `onsubmit` attributes remain in `views.js`. The server now
   sends a strict CSP: `default-src 'self'`, `script-src 'self'`,
   `style-src 'self'`, `img-src 'self' data:`,
   `connect-src 'self'`, `frame-ancestors 'none'`,
   `base-uri 'self'`, `form-action 'self'`.
   **Regression fixed along the way:** Phase 1's table escaping
   had turned admin Approve/Suspend/Reject buttons into visible
   text. `renderTable()` now escapes by default but allows a
   caller-specified `raw` column list, used only for admin action
   buttons generated from numeric ids and our own status enums —
   never for merchant-supplied text, which stays escaped. Admin
   actions now use `data-*` attributes + a delegated listener
   (CSP-safe, no inline handlers).
2. **Per-API-key rate limiting (was: IP only).**
   Added `server/src/lib/rate-limit.js` (sliding window, in-memory)
   and applied it after merchant authentication on `/api/v1/*`:
   600 requests / 15 min per merchant. Limitation is stated in
   the code and in `docs/API.md`: per-process store only; a
   multi-process VPS deployment needs a shared store.
3. **Webhook retry / delivery status / failure handling (was:
   queued only, no worker).** Added `scripts/deliver-webhooks.js`
   + `server/src/lib/webhook-delivery.js` + store methods
   `listDueWebhookLogs()` / `getWebhookById()`. Delivery updates
   `attempts`, `response_code`, `next_retry_at` (1m, 5m, 15m, 1h,
   6h backoff) and marks `failed` after 5 attempts. Webhook log
   API listings now strip the HMAC signature.
4. **MySQL timestamp formatting (found during docs verification).**
   JS ISO timestamps are now converted to MySQL
   `YYYY-MM-DD HH:MM:SS` (UTC) on invoice and session inserts
   (`server/src/lib/dates.js`), so Hostinger MySQL/MariaDB parsing
   does not depend on accepting the ISO `T`/`Z` form.

## Remaining risks — NOT claimed fixed

- CI workflow is still manual-only (see `docs/CI_MANUAL_ADD.md`).
- Per-key rate limiting is per-process (see above).
- Webhook delivery still needs the operator's cron job to actually
  run (Phase 3 preparation, not deployment).
- No independent security review has been done; `PAYMENTS_LIVE`
  stays false. Phase 4 (testnet) and Phase 5 (signing service)
  are still pending.
