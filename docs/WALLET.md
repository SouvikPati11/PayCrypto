# HD Wallet — Initialization, Backup, Recovery, Rotation

## Architecture

- Master seed: BIP39 mnemonic, BIP32/BIP44 derivation.
- Path: `m/44'/60'/0'/0/index` (BNB Smart Chain, coin type 60).
- One unique deposit address per invoice, unique derivation index
  enforced by `UNIQUE(derivation_index)` + a transactional allocation.
- Runtime derivation is watch-only when possible: the web app uses the
  xpub (`system_settings.wallet_xpub`) and never needs the seed.
- Treasury is a **separate wallet**. Never reuse the HD seed for
  treasury, and never use the treasury phrase as the HD seed.

## Initialization (once, secure machine)

```bash
ENCRYPTION_KEY=<64 hex chars> node scripts/init-wallet.js
```

It prints: xpub, first address, and the mnemonic **once**. Write the
mnemonic down offline (paper / hardware backup, two separate places),
then clear the terminal. The encrypted file `config/wallet.enc.json`
is gitignored — back it up offline too, but the mnemonic is the real
backup; the encrypted file is useless without `ENCRYPTION_KEY`.

## Recovery

1. On a secure offline machine, restore the mnemonic.
2. Re-derive addresses for indexes 0..N and compare with
   `deposit_addresses` in MySQL. Any mismatch means the wrong seed.
3. Re-encrypt with the current `ENCRYPTION_KEY` and restore
   `config/wallet.enc.json` if needed. Never paste the mnemonic into
   chat, email, a ticket, or a repo file.

## Rotation / emergency pause

- **Pause first:** set `EMERGENCY_PAUSE=true` (or Admin > Settings >
  emergency_pause). The monitor skips scanning and invoice creation
  returns 503 until the pause is cleared.
- **Rotate:** generate a new seed with `init-wallet.js`, set the new
  xpub, and keep the old seed available read-only until all old
  deposit addresses are swept or expired. Do not delete old address
  mappings — invoices still reference them.
- **Key compromise:** pause, rotate, sweep remaining funds from old
  addresses with the old keys via the signing service, then retire
  the old seed. Document the incident in the audit log.

## What never happens

- Seed / private keys in MySQL plaintext, in `.env`, in GitHub, in
  frontend code, or in logs.
- Production seeds from an online generator.
- Automatic sweeping or broadcasting without signing, fee and
  approval reviews (see `docs/PRODUCTION_READINESS.md`).
