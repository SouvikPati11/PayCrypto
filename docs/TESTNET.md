# Testnet Testing Guide (BNB Smart Chain Testnet, chain 97)

Real USDT transfers must remain disabled until the security review in
`docs/PRODUCTION_READINESS.md` passes. Testnet tokens have no value.

## 1. Setup

1. Set `BSC_NETWORK=testnet`, `BSC_RPC_URL_TESTNET` to a BSC testnet
   endpoint, and `CONFIRMATIONS=12` (or lower for faster tests).
2. Get tBNB from the official BSC testnet faucet for gas.
3. Get a test BEP20 token: use the faucet's BEP20 test tokens, or
   deploy a minimal test USDT-like token on testnet. **Verify it on
   testnet BscScan** (name, symbol, decimals) and only then set
   `USDT_CONTRACT_TESTNET` to that address. Do not copy the mainnet
   contract here — it does not exist on testnet.
4. Run `node scripts/init-wallet.js` on a secure machine, set the
   xpub in settings, approve a test merchant in Admin.

## 2. Happy path

1. Merchant creates an invoice for e.g. `1.5` USDT.
2. Open `/pay/<reference>` — note the unique deposit address.
3. Send the test token to that address from a testnet wallet.
4. Run `node scripts/monitor.js` (or wait for cron). The log should
   show the scanned range; after 12 confirmations the invoice
   becomes `paid`, the ledger credits exactly once, and a webhook
   log is queued.
5. Re-run the monitor: the same transfer must **not** credit again
   (duplicate tx + log index protection).

## 3. Edge cases to test on testnet

- Underpayment: send less than the invoice → status `underpaid`,
  no `paid` credit for the shortfall.
- Overpayment: send more → status `overpaid`.
- Wrong token: send a different test token to the address → ignored,
  no credit (contract mismatch).
- Wrong address: send to an unassigned address → ignored.
- Expiry: let an invoice expire, then pay late → it must not
  auto-mark `paid`; handle manually via admin review.
- RPC outage: stop the RPC / use a bad URL, run the monitor —
  it must fail without advancing the checkpoint, then succeed on
  retry with the same range.

## 4. Mainnet activation (only after review)

Re-verify the mainnet contract on BscScan
(`0x55d398326f99059fF775485246999027B3197955`, 18 decimals),
set `BSC_NETWORK=mainnet`, run the monitor in dry-run against a
known mainnet transfer first, and complete
`docs/PRODUCTION_READINESS.md`.
