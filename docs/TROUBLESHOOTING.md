# Troubleshooting

- **App won't start:** Node >=20? `npm install` clean? Startup file
  `server/index.js`? Check the Hostinger Node app log.
- **"HD wallet not initialized":** set `wallet_xpub` in Admin >
  Settings (from `scripts/init-wallet.js`).
- **"No USDT contract configured for testnet":** set
  `USDT_CONTRACT_TESTNET` after testnet BscScan verification.
- **Invoice never becomes paid:** cron running? Monitor log shows a
  new checkpoint? Correct chain, contract, address, amount? Enough
  confirmations (`CONFIRMATIONS`)? Receipt successful?
- **Duplicate credit concern:** check `blockchain_transactions`
  `UNIQUE(tx_hash, log_index)` and `ledger_entries.reference_key`
  — a second monitor run must not add a second credit.
- **Withdrawal stuck pending:** admin approval required by design.
  Approved withdrawals need an externally signed tx hash until a
  signing service is added.
- **Phone shows old site:** hard-refresh / clear cache; static
  assets are cached by the browser.
- **MySQL connection fails:** verify DB host/user/password in `.env`
  (hPanel databases often use a prefixed username), and that the
  database exists before running migrations.
