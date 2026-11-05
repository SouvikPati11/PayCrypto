# Phase 1 — Full Code and Security Audit (2026-11-05)

Scope: all 34 files on `main` at `adef9af7`, reviewed file by file
(server, routes, lib, scripts, migrations, public assets, docs).
Gates stay OFF: `PAYMENTS_LIVE=false`, `AUTO_SWEEP=false`,
`WITHDRAWAL_AUTO_BROADCAST=false`. No real funds were used.

## Findings fixed in this phase

1. **Expired invoices could credit on late payment (accounting, HIGH).**
   A confirmed transfer after expiry previously ran the normal credit
   path. Fixed: `processTransfer` now refuses to credit an expired
   invoice, records the transfer for audit, and moves the invoice to
   `expired`. `expirePendingInvoices()` (run by the monitor) also
   moves past-due pending invoices to `expired`.
2. **Withdrawal fee accounting was inconsistent (accounting, MEDIUM).**
   Validation required `amount + fee <= balance` but confirmation
   debited only `amount`, leaving the fee unaccounted for. Fixed:
   `amount` is now the gross withdrawal, `net = amount - fee`, and
   the debit on confirmation is exactly `amount`. Validation rejects
   amounts that do not exceed the fee.
3. **No CSRF protection on session-cookie requests (HIGH).**
   Dashboard POST/PATCH used only the ambient cookie. Fixed:
   double-submit CSRF token (`paycrypto_csrf` cookie + `X-CSRF-Token`
   header, set at login, sent automatically by `public/js/app.js`).
   Bearer API-key requests are exempt by design (not ambient).
4. **JWT sessions could not be revoked (MEDIUM).**
   Fixed: login now creates a `login_sessions` row keyed by the JWT's
   `jti`/token hash; the session middleware checks it, and logout
   revokes it. A revoked token no longer authenticates before expiry.
5. **Production could start with dev fallback secrets (HIGH).**
   Fixed: in production, startup now refuses to run unless
   `JWT_SECRET`/`SESSION_SECRET` are at least 32 chars and not the
   dev fallback, and `ENCRYPTION_KEY` is 64 hex chars.
6. **Confirming transfers that vanished in a reorg stayed confirming
   forever (MEDIUM).** Fixed: `reconcileOrphaned()` in the monitor
   marks confirming transfers absent from a re-scanned range as
   `orphaned`. They are never credited.
7. **Withdrawal overdraft via multiple approvals (MEDIUM).**
   Creation-time balance checks alone did not stop several approved
   withdrawals exceeding the balance. Fixed: confirmation now
   re-checks the derived balance and refuses to confirm (and debit)
   if it is insufficient. The balance API also reports pending
   withdrawal totals so the UI does not overstate availability.
8. **Pending merchants could create API keys / withdrawals (MEDIUM).**
   Approval previously gated only invoice creation. Fixed: approval
   now gates all merchant POSTs.
9. **Wallet overwrite risk (MEDIUM).** `init-wallet.js` now refuses
   to overwrite an existing `config/wallet.enc.json` unless
   `WALLET_OVERWRITE=true` is set deliberately (see docs/WALLET.md
   rotation procedure).
10. **Passphrase encryption used a static scrypt salt (LOW).**
    New encryptions use a random salt stored in the blob; legacy
    3-part blobs remain readable, never re-emitted.
11. **XSS via dashboard tables (MEDIUM).** `renderTable()` now HTML-
    escapes every cell. Admin tables render merchant-supplied business
    names, which previously went through `innerHTML` unescaped.
    Login/register error messages now use `textContent`.
12. **Dynamic SQL column names (LOW, defence in depth).**
    All update methods now enforce an allowlist of columns. All
    values were already parameterised; no SQL injection was found,
    but a future caller can no longer turn a patch object into an
    arbitrary column write.
13. **Dead/misleading code removed.** The unused `_queueInvoiceWebhook`
    stub in `api-v1.js` (which did nothing) was removed; webhook
    queueing lives in `scripts/monitor.js`, where the full webhook
    row and decrypted secret are available.
14. **Admin overview liabilities (LOW).** Overview now actually sums
    derived merchant ledger balances instead of only describing them
    in a note. TOTP setup now uses the user's real email in the
    otpauth URL.

## Checked and found sound (with evidence)

- **SQL injection:** all values are parameterised (`mysql2` `?`
  placeholders); no string-built queries with user input. Column
  names are now allowlisted (above).
- **Password hashing:** bcrypt, cost 12. Minimum password 10 chars.
  API keys: shown once, stored only as SHA-256.
- **HD wallet derivation:** ethers `HDNodeWallet`, BIP44
  `m/44'/60'/0'/0/index`, xpub watch-only derivation matches
  mnemonic derivation in tests. Seed is AES-256-GCM encrypted, never
  in MySQL plaintext, never committed, never sent to the frontend.
  Treasury is a separate wallet by design.
- **BSC verification:** exact contract-address match, Transfer topic
  check, receipt status, chain-ID validation, confirmation policy,
  `UNIQUE(tx_hash, log_index)` + `UNIQUE(ledger reference_key)`.
  No frontend claim or customer-supplied hash is trusted.
- **Admin RBAC:** `super_admin` (all), `admin` (manage, no settings
  writes), `support` (read-only) enforced per route; state changes
  are audit-logged.
- **Rate limiting:** 600/15 min on `/api/*`, 30/15 min on login.
- **Cookies:** session cookie is httpOnly, SameSite=Lax, Secure in
  production; CSRF cookie is readable by design (double-submit).

## Remaining risks — NOT claimed fixed

- **No CSP header** (helmet CSP is off) because dashboards use inline
  scripts. Mitigation is escaping (above) and server-generated
  markup; a strict CSP would require moving dashboard JS to external
  files — a Phase 2/3 hardening item, not a silent claim.
- **No per-API-key rate limit** yet; IP-based limits are the current
  control. Behind a Hostinger proxy, IP limits need `trust proxy`
  review (see Phase 3).
- **Webhook delivery worker** is still queued-by-monitor only; a
  production cron delivery worker is documented in `docs/API.md`.
- **Session expiry is 24h** with no idle timeout; revocation now
  covers logout, but stolen-token window is the JWT lifetime.
- **No security review by an independent party** has been done.
  This audit does not replace one, and `PAYMENTS_LIVE` stays false.
- **Testnet contract verification** is Phase 4, not Phase 1.
  Mainnet contract is verified (see README); testnet has no
  hardcoded contract by design.
