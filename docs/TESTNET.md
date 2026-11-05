# Testnet Testing Guide (BNB Smart Chain Testnet, chain 97)

Real USDT transfers must remain disabled until the security review in
`docs/PRODUCTION_READINESS.md` passes. Testnet tokens have no value.

## 1. Setup — verified values (Phase 4, 2026-11-05)

- Network: BNB Smart Chain Testnet (Chapel), **chain ID 97**
  (0x61). Mainnet is 56 — a different chain, never interchangeable.
- Default RPC (code): `https://bsc-testnet-dataseed.bnbchain.org`
  (live-checked 2026-11-05: chainId 97). Older endpoint
  `https://data-seed-prebsc-1-s1.bnbchain.org:8545` also answered
  chain 97 in the same check. Explorer: https://testnet.bscscan.com.
- Set `BSC_NETWORK=testnet`, `BSC_RPC_URL_TESTNET` to a testnet
  endpoint above, and `CONFIRMATIONS=12` (or lower for faster tests).

### How to obtain testnet BNB and test USDT safely

**tBNB (gas) — official BNB Chain testnet faucet only:**
1. Use a **test-only wallet** (a fresh wallet you create just for
   testing — never your main wallet, and never reuse a wallet
   that holds real funds for testnet experiments).
2. Go to the official faucet at https://testnet.bnbchain.org/faucet-smart
   (check the domain is `bnbchain.org` before pasting anything).
   BNB Chain docs also describe a Telegram bot
   (@bnbchain_official_bot) and Discord route, up to 0.3 tBNB/day.
3. Paste only your **public testnet address**. A legitimate faucet
   never asks for a seed phrase, private key, password or payment.
   If any page asks for one, close it — it is a scam.
4. tBNB has **no value** and cannot be sold or sent to mainnet.
   Never send real BNB to a testnet address; it cannot be recovered.

**Test USDT — there is no canonical testnet Tether USDT:**
No official Tether USDT contract exists on BSC testnet, and no
testnet "USDT" address in a blog post should be trusted. Use one
of these two legitimate routes, then verify on testnet BscScan:
1. **Faucet BEP-20 test tokens:** BNB Chain docs state the
   official faucet supports major pegged test tokens including
   USDT. Claim, then read the actual transfer on testnet BscScan
   and note the exact contract, name, symbol and decimals from
   that transaction.
2. **Deploy your own test-only token (recommended):** deploy a
   minimal ERC20/BEP20 on testnet with name e.g. "Test USDT",
   symbol **USDT**, decimals **18**, from your test-only wallet
   using faucet tBNB for gas. Verify it on testnet BscScan, then
   set that address as `USDT_CONTRACT_TESTNET`. This token is
   USDT-compatible for testing only — it is **not** Tether USDT
   and must never be presented as real USDT.
3. Only then set `USDT_CONTRACT_TESTNET` to that verified address.
   Do not copy the mainnet contract here — it does not exist on
   testnet, and PayCrypto will reject it (contract mismatch).
4. Run `node scripts/init-wallet.js` on a secure machine, set the
   xpub in settings, approve a test merchant in Admin. The
   monitor refuses to run on testnet until `USDT_CONTRACT_TESTNET`
   is set, and it verifies chain ID 97 and the token's symbol /
   decimals on-chain before scanning.

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

- Underpayment: send less than the invoice → status `underpaid`.
  The partial amount *is* credited to the merchant ledger (the
  merchant did receive those funds) — the invoice is simply not
  `paid` until it is topped up to the full amount.
- Overpayment: send more → status `overpaid`.
- Wrong token: send a different test token to the address → ignored,
  no credit (contract mismatch).
- Wrong address: send to an unassigned address → ignored.
- Expiry: let an invoice expire, then pay late → it must not
  auto-mark `paid` and must not credit the ledger; handle manually
  via admin review (Phase 1 fix, tested).
- RPC outage: stop the RPC / use a bad URL, run the monitor —
  it must fail without advancing the checkpoint, then succeed on
  retry with the same range.

## 4. Mainnet activation (only after review)

Re-verify the mainnet contract on BscScan
(`0x55d398326f99059fF775485246999027B3197955`, 18 decimals),
set `BSC_NETWORK=mainnet`, run the monitor in dry-run against a
known mainnet transfer first, and complete
`docs/PRODUCTION_READINESS.md`.
