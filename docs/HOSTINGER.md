# Hostinger Business Hosting — Deployment Guide

PayCrypto is one Node.js app + MySQL + cron. That is deliberate: Hostinger
shared hosting does not guarantee a permanently running worker, so nothing
in this design requires one.

## 1. Prerequisites

- Hostinger Business plan (Node.js support, MySQL database, Cron Jobs).
- A MySQL database + user created in hPanel > Databases.
- Node.js version 20+ selected in hPanel > Advanced > Node.js (or the
  Node.js app setup screen).

## 2. Upload

- Upload the repository contents to your app root (e.g. `~/paycrypto`),
  **not** to `public_html` directly. Keep `.env` outside the web root
  if your setup allows it.
- The repository root **must** contain `package.json` — Hostinger's
  Node importer detects the app from the root package.json.
- Run `npm install --omit=dev` in the app root (SSH or hPanel terminal).

## 3. Environment

Copy `.env.example` to `.env` in the app root and set:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`, `DB_PASSWORD`
  (from hPanel > Databases — never commit this file).
- `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY` (64 hex chars,
  long random values, different from each other).
- `BASE_URL` = your public domain with https.
- `BSC_NETWORK=testnet` to start. Do not switch to `mainnet` until
  `docs/PRODUCTION_READINESS.md` is complete.
- `TREASURY_ADDRESS` = the public treasury address only.
- Leave `PAYMENTS_LIVE=false`, `AUTO_SWEEP=false`,
  `WITHDRAWAL_AUTO_BROADCAST=false` until the reviews pass.

## 4. Database

```bash
node scripts/migrate.js
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' node scripts/seed-admin.js
```

If `node scripts/migrate.js` cannot reach MySQL from your shell, run the
SQL files in `db/migrations/` in order via phpMyAdmin instead.

## 5. HD wallet

On a secure machine (not in chat, not in a ticket):

```bash
ENCRYPTION_KEY=<same as .env> node scripts/init-wallet.js
```

Back up the mnemonic offline, then set `wallet_xpub` in Admin >
Settings (or `system_settings`) so the web app derives addresses
watch-only. Never upload `config/wallet.enc.json` to GitHub.

## 6. Start the app

- Startup file: `server/index.js`
- Application URL: your domain. The app serves the public site,
  dashboards and API from the same process.
- If Hostinger serves a static `public_html` in front, point the Node
  app's domain / proxy to the Node port as per hPanel's Node.js setup.

## 7. Cron — blockchain monitoring (required)

hPanel > Advanced > Cron Jobs, every 5 minutes (2 minutes on busier
sites, never more often than your RPC plan allows):

```
*/5 * * * * cd ~/paycrypto && /usr/bin/node scripts/monitor.js >> logs/monitor.log 2>&1
```

Check `logs/monitor.log`: a successful run prints the scanned block
range and the new checkpoint. On RPC failure the checkpoint is **not**
advanced, so the next run retries the same range — do not manually
advance the checkpoint.

Webhook delivery cron (also required, every minute):

```
* * * * * cd ~/paycrypto && /usr/bin/node scripts/deliver-webhooks.js >> logs/webhooks.log 2>&1
```

CSP note (Phase 2): all page JavaScript now lives in external
`/js/*.js` files and the server sends a strict CSP
(`script-src 'self'`, `frame-ancestors 'none'`). Do not add inline
scripts to dashboard pages without updating the CSP.

## 8. Troubleshooting

- App won't start: check Node version (>=20), `npm install` output,
  and that `server/index.js` is the startup file.
- "HD wallet not initialized": set `wallet_xpub` in settings.
- "No USDT contract configured for testnet": set
  `USDT_CONTRACT_TESTNET` after testnet BscScan verification.
- Invoices created but never paid: check the cron log, the RPC URL,
  and that the customer sent the **configured** contract's USDT to the
  exact deposit address on the **configured** chain.
- Old CSS/JS on a phone: hard-refresh (device cache), as with any
  static-asset change.

## 9. Future VPS migration

No rewrite is needed: the same app runs on a VPS with PM2/systemd,
the same MySQL schema, and the same cron monitor. On a VPS you may
add a dedicated signing service and a webhook delivery worker — both
are documented as separate, optional services, not as changes to the
core ledger or invoice logic.
