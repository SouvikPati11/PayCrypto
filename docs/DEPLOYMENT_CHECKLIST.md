# Phase 3 Preparation — Hostinger Deployment Checklist

This is preparation only. No deployment has been performed, no
hosting credentials were used or invented, and no step below assumes
hosting access is available. The operator completes the Hostinger
steps in their own hPanel account.

## 1. Hostinger Business compatibility — confirmed from code

- **Node.js app:** one process, startup file `server/index.js`,
  `package.json` at the repository root (Hostinger's Node importer
  detects the app from the root `package.json`), `engines: >=20`.
  Start command: `node server/index.js` (`npm start`).
- **No permanent worker required:** blockchain monitoring and
  webhook delivery are cron scripts, not daemons. See §5.
- **Database:** MySQL only (no PostgreSQL, Redis, Docker required).
  All queries are parameterised; schema is in `db/migrations/`.
- **Static assets:** served by Express from `public/` (CSS/JS).
  No separate frontend build step, no Next.js server required.
- **Ports:** the app listens on `$PORT` (Hostinger sets this for
  Node apps; default 3000 locally). Do not hardcode a port in hPanel.

## 2. Exact MySQL setup (hPanel → Databases)

1. Create a MySQL database, e.g. `u123456789_paycrypto`
   (use the exact name hPanel assigns — do not invent one here).
2. Create a MySQL user and grant it **only** to that database
   (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
   are needed for migrations; DROP is not needed after setup).
3. Note the host (usually `localhost` on shared hosting), database
   name, username and password from hPanel — put them only in the
   server `.env`, never in GitHub.
4. Import migrations in order, either via SSH/terminal:
   ```bash
   mysql -h <host> -u <user> -p <database> < db/migrations/001_schema.sql
   mysql -h <host> -u <user> -p <database> < db/migrations/002_seed.sql
   ```
   or via phpMyAdmin → Import, uploading `001_schema.sql` first,
   then `002_seed.sql`. If phpMyAdmin splits on `DELIMITER`, use
   the terminal method — these files use no stored procedures, so
   plain import works.
5. Verify tables exist: `users`, `merchants`, `merchant_profiles`,
   `api_keys`, `deposit_addresses`, `invoices`,
   `blockchain_transactions`, `ledger_entries`, `withdrawals`,
   `treasury_transactions`, `sweep_jobs`, `webhooks`,
   `webhook_logs`, `audit_logs`, `system_settings`,
   `login_sessions`, `monitor_checkpoints`.

## 3. Application setup commands (in the app root)

```bash
npm install --omit=dev
cp .env.example .env
# Edit .env in hPanel File Manager / terminal ONLY (see §6).
node scripts/migrate.js
ADMIN_EMAIL=<your-admin-email> ADMIN_PASSWORD='<a-long-password>' node scripts/seed-admin.js
# Change that password immediately after first login and enable 2FA.
# HD wallet (secure machine, see docs/WALLET.md):
ENCRYPTION_KEY=<same-as-.env-64-hex> node scripts/init-wallet.js
# Then set wallet_xpub in Admin → Settings.
npm start
```

## 4. Startup verification (do not skip)

- `GET /health` returns `ok: true`, `network: testnet`,
  `chain_id: 97`, `payments_live: false`.
- Home page loads, CSS/JS load from `/css/style.css` and `/js/*.js`
  (CSP is now `script-src 'self'` — no inline scripts remain).
- Login with the seeded admin works; logout revokes the session
  (Phase 1 fix, verified by HTTP test).
- A pending merchant cannot create invoices until an admin
  approves them (403, verified).

## 5. Cron Jobs (hPanel → Advanced → Cron Jobs)

Monitor (required, every 5 minutes):
```
*/5 * * * * cd ~/paycrypto && /usr/bin/node scripts/monitor.js >> logs/monitor.log 2>&1
```
Webhook delivery (required for webhook retries, every 1 minute):
```
* * * * * cd ~/paycrypto && /usr/bin/node scripts/deliver-webhooks.js >> logs/webhooks.log 2>&1
```
Replace `~/paycrypto` with your actual app path and
`/usr/bin/node` with the Node binary path hPanel shows, if different.
Check both logs: monitor must show a new checkpoint each run;
on RPC failure the checkpoint must NOT advance (next run retries).

## 6. Production environment checklist

Every variable below is in `.env.example` (verified against code
in Phase 2). No variable in code is missing from `.env.example`
except `WALLET_MNEMONIC` / `WALLET_OVERWRITE`, which are
init-wallet-only and are now documented there as optional.

| Variable | Production value rule |
|---|---|
| `NODE_ENV` | `production` (refuses weak secrets if unset) |
| `PORT`, `BASE_URL` | Hostinger port / your https domain |
| `DB_HOST/PORT/USER/PASSWORD/NAME` | From hPanel Databases only |
| `JWT_SECRET`, `SESSION_SECRET` | Long random, different, ≥32 chars |
| `ENCRYPTION_KEY` | 64 hex chars, never committed |
| `BSC_NETWORK` | `testnet` until Phase 4/5 reviews pass |
| `BSC_RPC_URL*` | Your RPC endpoint per network |
| `USDT_CONTRACT_MAINNET` | Verified mainnet contract (see README) |
| `USDT_CONTRACT_TESTNET` | Only after testnet BscScan verification |
| `TREASURY_ADDRESS` | Public address only, never a private key |
| `CONFIRMATIONS`, `REORG_DEPTH` | 12 / 12 defaults |
| `PAYMENTS_LIVE`, `AUTO_SWEEP`, `WITHDRAWAL_AUTO_BROADCAST` | **Must stay `false`** |
| `CRON_SECRET` | Only if using the HTTP cron trigger |

## 7. What is NOT done in Phase 3 preparation

- No Hostinger account was accessed, no app was created, no files
  were uploaded, no database was created, no cron job was set.
- No real credentials, passwords, secrets, private keys or
  recovery phrases were requested, used or committed.
- Phase 4 (testnet payment tests) and Phase 5 (signing service)
  are still pending and are not claimed here.
