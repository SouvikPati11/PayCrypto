# Phase 5 — Secure Signing Service

## 1. Why a separate service

The PayCrypto web app (Hostinger shared hosting) must never hold
signing keys. Shared hosting is a multi-tenant environment: a
compromised web process, a leaked `.env`, or a backup of the app
folder would otherwise give an attacker custody of merchant funds.
So signing lives in a **separate process on a separate host**,
with its own encrypted vault, its own HMAC secret, and no database
or web-app access beyond the single `/sign` endpoint it exposes.

```
                          Private network / VPN / firewall allowlist only
  ┌─────────────────────┐      HMAC + timestamp + nonce      ┌──────────────────────┐
  │  PayCrypto web app  │ ──────────────────────────────────> │  Signer service      │
  │  Hostinger Business │   (operator scripts only,          │  Separate VPS /       │
  │  Node + MySQL       │    never web routes, never cron)   │  isolated host        │
  │  xpub only, no keys │                                    │  Encrypted vault     │
  └─────────────────────┘                                    │  (deposit mnemonic + │
        ▲                                                    │   treasury key)      │
        │  Merchant / admin dashboards, API, monitor          │  No public internet  │
        └────────────────────────────────────────────────────┘  │  access by default │
                                                                └──────────────────────┘
                                                                       │
                                                                       │  Signed tx
                                                                       ▼
                                                              BNB Smart Chain
                                                              (testnet 97 / mainnet 56)
```

**What runs on Hostinger:** the web app, MySQL, monitor cron,
webhook delivery cron. **What runs separately:** the signer
service only. **What never runs automatically:** sweeping and
withdrawal broadcasting. `AUTO_SWEEP=false` and
`WITHDRAWAL_AUTO_BROADCAST=false` stay off, and the operator
scripts refuse to run while those flags are true.

## 2. What the signer does

- **Sweep:** for a deposit address index, derive the HD wallet
  (`m/44'/60'/0'/0/index`), build a USDT transfer to the
  **configured treasury address only**, sign, optionally broadcast,
  verify the receipt. A sweep to any other destination is refused
  by the signer itself, even if the backend request is forged.
- **Withdrawal:** for an admin-approved withdrawal, sign a USDT
  transfer from the **treasury wallet** to the approved destination.
  The backend script checks the withdrawal is `approved` and has
  no existing `tx_hash` before calling the signer; the signer
  additionally requires `withdrawal_id` + `approved_by` in the
  request and enforces all limits below.
- **Validation (before any signing):** job_id present, kind is
  `sweep` or `withdrawal`, destination is a valid BSC address,
  amount positive and within per-transaction limit, contract is
  exactly the configured USDT contract, chain ID matches, sweep
  destination = treasury, withdrawal destination ≠ treasury.
- **Gas management:** gas price from the provider, capped at
  `SIGNER_MAX_GAS_PRICE_GWEI` (default 5); gas limit estimated
  + 20% buffer; the signing wallet's BNB balance must cover
  `gasLimit × gasPrice`, otherwise signing is refused with an
  explicit error; the USDT balance must cover the amount.
  Gas is always paid in BNB from the signing wallet — deposit
  addresses therefore need a small BNB top-up before sweeping,
  and the treasury needs BNB before withdrawals. See §7.
- **Broadcast + receipt:** if `SIGNER_DRY_RUN=false`, the signed
  tx is broadcast and the receipt is waited for (12 confirmations
  by default) and verified: status 1, receipt contract = USDT
  contract, and a Transfer log (if present) matching destination
  and amount. A failed receipt is an error, not a success.
  In dry-run mode (the default), signing is performed but nothing
  is broadcast and no receipt is claimed.
- **Limits:** per-transaction (`SIGNER_MAX_TX_USDT`, default
  10,000) and daily (`SIGNER_DAILY_LIMIT_USDT`, default 10,000),
  tracked in signer state (persisted to `SIGNER_STATE_FILE` if
  set, otherwise in-memory). Dry-run signatures do not consume
  the daily limit; only verified broadcasts do.
- **Replay + duplicate protection:** every request carries
  `X-Signer-Timestamp` (must be within 5 minutes) and
  `X-Signer-Nonce` (rejected if ever reused), plus an HMAC-SHA256
  signature over method + path + timestamp + nonce + body, using
  `SIGNER_API_SECRET` (≥32 chars, signer host + backend only).
  Every `job_id` is recorded: a second request for the same job
  returns the first result and never signs or broadcasts again.
- **Audit logging:** every auth failure, validation failure,
  dry-run, broadcast and duplicate is logged as a JSON line
  (console + `SIGNER_AUDIT_FILE` if set) with job_id, kind,
  from/to, amount and tx hash. Private keys, mnemonics and signed
  raw transactions are **never** logged or returned.

## 3. Secure communication

1. Signer binds `SIGNER_HOST` (default `127.0.0.1`) and
   `SIGNER_PORT` (default 4100). Do not bind `0.0.0.0` on a public
   interface without a firewall.
2. Put the signer behind a private network (VPC private IP,
   Tailscale/WireGuard, or a firewall allowlist containing only
   the Hostinger/backend egress IP). Public internet access to
   `/sign` must be blocked at the network layer, not just by HMAC.
3. Use HTTPS (reverse proxy with TLS) if the signer is reachable
   over any untrusted network. HMAC protects integrity and
   authenticity, but not confidentiality of the request body.
4. Rotate `SIGNER_API_SECRET` on any suspected backend compromise
   (see §6). Rotating it does **not** require rotating signing keys.
5. Rate limiting: 60 requests/minute per IP in the signer itself,
   in addition to the network allowlist.

## 4. Key storage — what is allowed and what is forbidden

**Allowed (signer host only):**
- `config/signer-vault.enc.json`: AES-256-GCM encrypted vault
  containing the deposit mnemonic and treasury private key,
  0600 permissions, gitignored, created only by
  `scripts/init-signer-vault.js` on the signer host.
- `SIGNER_VAULT_KEY` (64 hex): the vault encryption key, set
  only in the signer host's environment (systemd
  `EnvironmentFile` with 0600, or a secrets manager), never in
  the repository, never in Hostinger `.env`, never in chat.
- Keys are decrypted into memory at signer startup and never
  written back to disk in plaintext.

**Forbidden:**
- Deposit mnemonics or treasury private keys in `.env`, in
  Hostinger application files, in MySQL, in GitHub, in logs,
  in screenshots, or in chat. If a key ever appears in any of
  those places, treat it as compromised and rotate (see §6).
- Reusing the deposit seed for treasury, or vice versa. They are
  separate wallets by design.

## 5. Hardware-backed / managed custody options

For production, an isolated VPS with an encrypted vault is the
minimum, not the ceiling. In increasing assurance (and cost):

1. **Dedicated VPS + encrypted disk + vault (this implementation).**
   Lowest cost, operator-managed. Key risk: a host compromise
   exposes keys in memory. Mitigate with firewalling, no SSH
   password login, automatic security updates, and no other
   services on the host.
2. **Cloud KMS (AWS KMS, GCP Cloud KMS, Azure Key Vault).**
   The private key is generated and held inside the KMS and
   **never exported**; the signer sends the transaction hash to
   KMS for signing and receives only the signature. This removes
   key extraction from the threat model, at the cost of KMS API
   calls and vendor lock-in. Implementing KMS signing means
   replacing the vault keyProvider with a KMS keyProvider —
   the signer core's validation, limits and audit logic are
   unchanged. This is the recommended production upgrade path.
3. **Hardware Security Module (HSM) / dedicated signing appliance.**
   Keys in FIPS-certified hardware, signing via PKCS#11. Highest
   assurance, highest cost and operational complexity.
4. **MPC / institutional custody (e.g. Fireblocks, Copper).**
   Threshold signing with no single key holder, with policy
   controls and insurance. Appropriate only at scale; it replaces
   the signer service rather than extending it.
5. **Hardware wallet (Ledger/Trezor) for treasury only.**
   Suitable for manual, low-frequency treasury operations, not
   for an always-on signer — a human must approve each tx on
   the device. Do not use a hardware wallet as the deposit
   sweeping key: sweeping needs automated HD derivation.

**Recommendation for PayCrypto at its current scale:** start with
(1) on testnet, prove the manual flow, then move to (2) before
any mainnet activation. Do not activate mainnet on (1) alone
without an independent security review.

## 6. Key rotation, backup and recovery

**Backup (do this at vault creation, before any funds arrive):**
- Back up the encrypted vault file to a second offline location
  (encrypted USB / separate host). Backing up the encrypted file
  alone is not enough if `SIGNER_VAULT_KEY` is lost — back up
  the vault key separately, offline, in a safe.
- Back up the deposit mnemonic on paper/metal, offline, in a
  safe, in a different location from the vault key. Anyone with
  both the vault file and the vault key, or with the mnemonic
  alone, controls the deposit funds.
- Test recovery once on testnet: restore the vault on a fresh
  host, start the signer in dry-run, and confirm the derived
  index-0 address matches. An untested backup is not a backup.

**Rotation:**
1. Generate a new vault (new deposit mnemonic + new treasury key)
   with `SIGNER_VAULT_OVERWRITE=true` on the signer host, or on a
   fresh host for a clean cutover.
2. Update the PayCrypto `wallet_xpub` (from the new deposit
   mnemonic) and `TREASURY_ADDRESS` (new treasury address) in
   Admin settings. New invoices use new deposit addresses.
3. Sweep/drain all old deposit addresses and the old treasury to
   the new treasury, using the old signer, and verify on-chain.
4. Only after every old address balance is zero and no invoice
   references an old address, decommission the old vault (secure
   delete, not just `rm` on a journaling filesystem — use
   `shred` / disk encryption rotation where available).
5. Rotate `SIGNER_API_SECRET` at the same time if the rotation
   was triggered by a suspected compromise.

**Compromise response:** if a signing key is suspected leaked,
stop the signer immediately, rotate as above, and treat any
transaction signed after the suspected leak time as untrusted
until verified on-chain. Do not "wait and see" with real funds.

## 7. Gas management for sweeping (operator checklist)

- Each deposit address needs BNB for gas **before** sweeping.
  A USDT transfer costs roughly 50k–70k gas; at 3–5 gwei that is
  ~0.0002–0.00035 BNB per sweep. Top up deposit addresses with
  a small, fixed BNB amount (e.g. 0.001 BNB) from treasury when
  an invoice is created or when a sweep is planned — never send
  a large BNB balance to a deposit address.
- If a sweep fails with "Insufficient BNB for gas", top up that
  deposit address with tBNB (testnet) / BNB (mainnet, after review)
  and retry with a **new** job_key — do not reuse the failed job's
  key if you want a fresh attempt, or reuse it to get the
  original result (the signer returns the first result for a
  job_id, it never re-signs).
- If gas price exceeds `SIGNER_MAX_GAS_PRICE_GWEI`, the signer
  refuses to sign. Wait for gas to fall, or raise the cap
  deliberately (and only deliberately) on the signer host.
- Sweep only amounts above `SIGNER_MIN_SWEEP_USDT` and above the
  gas cost in USDT terms, otherwise the sweep costs more than it
  recovers. The signer enforces the balance checks; the operator
  enforces the economic decision.

## 8. Deployment architecture — what runs where

| Component | Host | Keys? | Notes |
|---|---|---|---|
| Web app + dashboards + API | Hostinger Business | No (xpub only) | `server/index.js`, root `package.json` |
| MySQL | Hostinger | No | Ledger, invoices, sessions, checkpoints |
| Monitor cron (5 min) | Hostinger | No | Watch-only, verifies on-chain |
| Webhook delivery cron (1 min) | Hostinger | No (signatures pre-computed) | `scripts/deliver-webhooks.js` |
| **Signer service** | **Separate VPS / isolated host** | **Yes, encrypted vault only** | `services/signer/index.js`, port 4100, private network only |
| Operator scripts | Operator machine / backend host | No (HMAC secret only) | Manual, `SIGNER_MANUAL_CONFIRM=yes` required |
| Vault + vault key | Signer host + offline backup | Yes | Never in repo, never in Hostinger `.env` |

## 9. Cost and infrastructure requirements

Estimates, not quotes — prices change, and testnet costs nothing
except time. All figures are for the **signer host only**; Hostinger
Business costs are unchanged (the web app is already running there).

- **Minimum (testnet / proving the flow):** a small VPS
  (1 vCPU, 1–2 GB RAM, 20 GB disk) — typically $4–$10/month from
  common VPS providers, plus a domain/TLS only if you expose
  HTTPS (not required on a private network). No per-transaction
  fee from the signer itself.
- **Recommended (pre-mainnet):** same VPS size, plus automated
  backups/snapshots ($1–$5/month), a private network / VPN
  (often free with the VPS provider, or Tailscale free tier),
  and monitoring (uptime + signer audit log alerts). Total
  roughly $5–$20/month for the signer host.
- **KMS upgrade (recommended before mainnet):** cloud KMS key
  storage is typically ~$1/month per key plus ~$0.03 per 10,000
  signing operations (provider-dependent). This is the cheapest
  way to remove key extraction from the threat model.
- **HSM / institutional custody:** hundreds to thousands of
  dollars per month, plus setup — not justified until volume
  warrants it.
- **On-chain costs (per transaction, not per month):** BSC gas
  in BNB, roughly 50k–70k gas per USDT transfer. At 3–5 gwei,
  ~0.0002–0.00035 BNB per sweep/withdrawal. Testnet gas is paid
  in free faucet tBNB. Mainnet gas must be budgeted from treasury
  BNB, separately from USDT balances.
- **Human cost (the real one):** someone must review every
  manual sweep/withdrawal, monitor signer audit logs, rotate
  keys on schedule, and test recovery. An unmonitored signer is
  not a secure signer, however good the code is.

## 10. Manual testnet testing (see §11 in the Phase 5 report)

1. On the signer host (or a local test host — never Hostinger),
   create a test vault, start the signer in dry-run, check
   `/health`.
2. Set `USDT_CONTRACT_TESTNET` to your verified test token,
   create and approve a test merchant, create an invoice, and
   fund a deposit address with test tokens + tBNB for gas.
3. Run `request-sweep.js` (dry-run first, then with
   `SIGNER_DRY_RUN=false` on the signer) and verify the sweep
   tx on testnet BscScan and the sweep job status.
4. Create a withdrawal, approve it in Admin, run
   `request-withdrawal.js` the same way, and verify the
   destination receipt, the `confirmed` status, and the ledger
   debit — all on testnet, with test tokens only.
