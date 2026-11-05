# PayCrypto — USDT (BEP20) Payment Gateway

Accept USDT on **BNB Smart Chain only** (BEP20, chain 56 mainnet / 97 testnet).
Every invoice gets a unique HD deposit address, every payment is verified
on-chain, and every credit goes through an auditable ledger exactly once.

> **Safety gate:** this release defaults to testnet with
> `PAYMENTS_LIVE=false`, `AUTO_SWEEP=false` and
> `WITHDRAWAL_AUTO_BROADCAST=false`. Real-money custody and automatic
> withdrawals stay disabled until the security, operational and legal
> reviews in `docs/PRODUCTION_READINESS.md` are complete.

## What is built

- **Public site:** home, features, pricing, about, contact, FAQ, docs,
  API docs, terms, privacy, login, merchant registration — dark premium,
  responsive, mobile-first.
- **Merchant dashboard:** balance (derived from ledger), invoices, pay
  pages, payments, withdrawals, API keys, webhooks, 2FA.
- **Admin dashboard:** overview, merchants (approve/suspend), invoices,
  transactions, wallets, withdrawals (approve/reject), sweep jobs,
  settings, audit logs, role-based access (super_admin / admin / support).
- **HD wallet:** BIP39/BIP32/BIP44, path `m/44'/60'/0'/0/index`, unique
  derivation index, watch-only xpub derivation. Seed is encrypted with
  AES-256-GCM, never stored in MySQL in plaintext, never committed.
- **Blockchain monitor:** cron-compatible, resumable via DB checkpoints,
  reorg re-scan, confirmation policy, receipt verification, exact
  contract-address enforcement, duplicate protection via
  `UNIQUE(tx_hash, log_index)` + `UNIQUE(ledger reference_key)`.
- **Treasury:** separate from deposit addresses. Sweep jobs are
  manual-review only in this build; BNB gas is never assumed free.
- **API v1:** invoices, balance, transactions, withdrawals, API keys,
  webhooks (HMAC-SHA256), idempotency keys, rate limiting.
- **Database:** MySQL migrations for all 16 required tables plus a
  monitor-checkpoint table. Balances are derived, not edited.

## Quick start (local, testnet, no real funds)

```bash
cp .env.example .env
# For a database-free demo/test run only:
MEMORY_DB=true npm install
MEMORY_DB=true npm test
MEMORY_DB=true npm start
# Open http://localhost:3000
```

For MySQL:

```bash
npm install
# set DB_* in .env, then:
node scripts/migrate.js
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' node scripts/seed-admin.js
node scripts/init-wallet.js   # prints xpub + mnemonic ONCE — back it up offline
npm start
```

Then set `wallet_xpub` in system settings (admin) so invoices can derive
deposit addresses watch-only, without the seed on the web server.

## Cron (Hostinger)

See `docs/HOSTINGER.md`. In short:

```
*/5 * * * * cd ~/paycrypto && /usr/bin/node scripts/monitor.js >> logs/monitor.log 2>&1
```

## Verified token contract

- Mainnet USDT (BEP20): `0x55d398326f99059fF775485246999027B3197955`,
  18 decimals, chain 56. Re-verify on BscScan before production activation;
  the monitor enforces an exact match and rejects all other contracts.
- Testnet: there is no single canonical USDT. Verify a testnet token on
  testnet BscScan first, then set `USDT_CONTRACT_TESTNET`. See
  `docs/TESTNET.md`.

## Tests

`npm test` — authentication, authorisation, invoice creation, unique
address/index, token-contract validation, transfer detection,
confirmation tracking, duplicate prevention, under/overpayment, ledger
accounting, withdrawal validation, sweep idempotency, RPC-failure
recovery (unconfirmed transfers never credit).

## Honest limitations (v1.0.0)

- No automatic on-chain sweep or withdrawal broadcast. Approved
  withdrawals move to `awaiting_broadcast`; an operator (or a future
  dedicated signing service) records the externally signed tx hash.
  This is deliberate, not a missing test — see
  `docs/PRODUCTION_READINESS.md`.
- No live mainnet deployment is claimed. Production activation needs
  the checklist in `docs/PRODUCTION_READINESS.md`, including a security
  review, key-management review and legal review.
- Webhook delivery workers: the monitor queues signed deliveries;
  a production deployment should add a small cron delivery worker
  (pattern documented in `docs/API.md`) rather than relying on the
  monitor pass alone.
- The public contact form is a demo form; wire it to a helpdesk in
  production.
