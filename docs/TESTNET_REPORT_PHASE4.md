# Phase 4 — BSC Testnet Verification & Payment Testing Report (2026-11-05)

Base: `main` at `f4756fff`, Phase 4 changes (see §7).
Gates stay OFF: `PAYMENTS_LIVE=false`, `AUTO_SWEEP=false`,
`WITHDRAWAL_AUTO_BROADCAST=false`. No real funds used, no private
key or recovery phrase requested, handled or committed. No live
testnet transaction was sent by the agent — sending one requires
a test wallet the operator controls, so that step is listed as
manual in §6.

## 1. BSC Testnet configuration — verified live, not assumed

Source: BNB Chain official docs
(https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/
and /developers/wallet-configuration/), cross-checked against the
live network on 2026-11-05.

| Item | Verified value |
|---|---|
| Network | BNB Smart Chain Testnet (Chapel) |
| Chain ID | **97** (0x61) — mainnet is 56, a different chain |
| Currency | tBNB (test BNB, no value) |
| Explorer | https://testnet.bscscan.com |
| RPC (default in code, Phase 4) | https://bsc-testnet-dataseed.bnbchain.org |
| RPC (older, still works) | https://data-seed-prebsc-1-s1.bnbchain.org:8545 |
| Mainnet RPC (for comparison only) | https://bsc-dataseed.bnbchain.org |

Live check (ethers `JsonRpcProvider`, 2026-11-05, no funds involved):
both testnet endpoints returned `chainId = 97` and a current block
around 140,876,0xx. The monitor enforces this with
`validateChainId(provider, config.chainId)`: a mainnet RPC (56)
under a testnet config (97) fails **before any scanning**, and a
testnet RPC under a mainnet config fails the same way.

Code change: the default testnet RPC in `server/src/lib/config.js`
and `.env.example` was updated from the older
`data-seed-prebsc-1-s1.binance.org:8545` to the current BNB Chain
docs endpoint `bsc-testnet-dataseed.bnbchain.org` (the old one
still answered correctly in the live check, so this is a currency
update, not a fix for a broken endpoint). Mainnet default updated
likewise to `bsc-dataseed.bnbchain.org`. `BSC_RPC_URL` /
`BSC_RPC_URL_TESTNET` / `BSC_RPC_URL_MAINNET` still override them.

## 2. Testnet USDT — honest finding: there is no canonical one

Searches of testnet BscScan and BNB Chain docs found **no official
Tether USDT contract on BSC testnet**, and no single canonical
testnet USDT address published by Tether or BNB Chain. The
testnet tokens named "USDT" that appear on testnet BscScan (e.g.
"Alita USDT", "TempUSDT") are third-party test tokens, not Tether
USDT, and none of them is endorsed here.

Therefore PayCrypto **does not hardcode any testnet contract**.
`USDT_CONTRACT_TESTNET` stays empty by default, and the monitor
refuses to run on testnet until the operator sets it after their
own testnet BscScan verification (exit code 2, clear message).
Any guide that pastes a "testnet USDT address" without that
verification step would be inventing a contract — this report
does not do that.

### Legitimate test-token options (operator chooses, then verifies)

1. **Official BNB Chain testnet faucet's BEP-20 test tokens.**
   BNB Chain docs state the faucet supports major pegged test
   tokens including USDT. Claim, then read the actual transfer
   on testnet BscScan and note the exact token contract, name,
   symbol and decimals from that transaction — do not copy an
   address from a blog post or chat.
2. **Deploy your own test-only token (recommended for repeatable
   tests).** Deploy a minimal ERC20/BEP20 on testnet with name
   e.g. "Test USDT", symbol **USDT**, decimals **18**, from a
   test-only wallet funded with faucet tBNB. Verify the contract
   on testnet BscScan, then set that address as
   `USDT_CONTRACT_TESTNET`. This token is USDT-*compatible*
   (same interface and decimals, so PayCrypto's verification
   passes) but it is **not Tether USDT** and must never be
   described as real USDT. Its only purpose is integration testing.

In both cases, PayCrypto's on-chain check must pass before any
credit: `verifyTokenContract` requires symbol exactly `USDT`
and decimals exactly `18`, and the monitor requires an exact
contract-address match. A token with symbol `TUSDT` or 6 decimals
is rejected (tested, §4).

## 3. Testnet / mainnet separation — how it is enforced

- `BSC_NETWORK` selects exactly one chain ID (97 or 56), one RPC
  default and one contract (`usdtContractForNetwork()`). There is
  no code path that mixes them: a transfer is parsed only if its
  log address equals the configured contract for the selected
  network (`parseTransferLog` + `isCanonicalTokenContract`).
- Mainnet contract `0x55d398326f99059fF775485246999027B3197955`
  is **never** used on testnet: it does not exist as a contract
  on chain 97, and even in simulation a mainnet-contract transfer
  against a testnet expectation is ignored (tested, §4).
- The monitor fails closed when the testnet contract is unset,
  when the chain ID mismatches, and when token verification fails.
- Separate `.env` values: `USDT_CONTRACT_MAINNET` and
  `USDT_CONTRACT_TESTNET` are independent variables; setting one
  never changes the other.

## 4. Automated test results — 28/28 pass (was 19/19)

New Phase 4 tests (9 tests, deterministic simulations, no live tx):

| Scenario | Result |
|---|---|
| HD deposit addresses unique per invoice, deterministic, xpub matches mnemonic | Pass |
| Exact payment: confirming (not credited) → confirmed at 12 blocks (credited once) | Pass |
| Contract validation: wrong token ignored; mock-provider symbol `USDT`/18 passes, `TUSDT`/6 rejected; chain 56 vs 97 rejected | Pass |
| Failed receipt never credits; **missing receipt never credits** (Phase 4 fix, was able to credit) | Pass |
| Underpayment → `underpaid`, ledger holds the partial amount; overpayment → `overpaid`, ledger holds full amount | Pass |
| Duplicate tx+logIndex never credits twice; same tx, different logIndex credits separately | Pass |
| Reorg: confirming transfer vanishing from re-scan → `orphaned`, never credited | Pass |
| Testnet/mainnet isolation both directions | Pass |
| Ledger crediting + withdrawal approval validation + simulated confirmed debit | Pass |

Plus the pre-existing Phase 1 tests for expired/late payments,
orphan reconcile and session revocation, which still pass.

## 5. Bugs fixed in Phase 4

1. **Missing receipt could credit (fail-closed fix).**
   `processTransfer` previously treated a missing
   (`undefined`) receipt as successful. Now only an explicit
   `receiptStatus === true` counts; anything else is `failed`
   and never credits. The monitor always passes a boolean, so
   this hardens the function against a future caller error.
2. **Second payment to an already-paid invoice was not credited.**
   Previously, once an invoice was `paid`, a further confirmed
   transfer to the same deposit address was recorded but never
   added to the merchant ledger — received funds would vanish
   from accounting. Now the ledger entry is created (still
   exactly once per tx+logIndex), while the invoice stays `paid`
   and is not reclassified. This is an accounting fix, not a
   change to invoice states for the normal path.
3. **RPC defaults were stale** (see §1).

No other Phase 4 scenario found a code bug. Underpayment
crediting the partial amount to the ledger is intentional:
the merchant did receive those funds; the invoice correctly
stays `underpaid` until topped up. This is now stated explicitly
in `docs/TESTNET.md` to avoid misreading it as "underpaid = paid".

## 6. What still requires MANUAL testing (not claimed done)

These need a test wallet the operator controls. The agent did
not send, and must not be asked to send, any live transaction
with the operator's keys.

1. **Live testnet payment, end to end:** claim tBNB + a test
   token (see `docs/TESTNET.md` §1), set `USDT_CONTRACT_TESTNET`
   to the verified test token, create an invoice, send the exact
   test-token amount to its deposit address from a test wallet,
   run `node scripts/monitor.js`, wait 12 confirmations, and
   confirm on testnet BscScan + in the dashboard that the
   invoice is `paid`, the ledger credits once, and a webhook
   log is queued. Re-run the monitor and confirm no second credit.
2. **Live under/over/wrong-token/late-payment cases** on testnet,
   following `docs/TESTNET.md` §3, one at a time.
3. **Live RPC outage:** run the monitor against a bad RPC URL,
   confirm it fails without advancing the checkpoint, then
   retry with the correct URL and confirm the same range is
   re-scanned.
4. **Withdrawal broadcast:** approval flow is tested at the
   ledger/validation level only. Broadcasting an approved
   withdrawal on testnet is Phase 5 (signing service) work and
   must not be attempted with a production key.
5. **Mainnet activation:** not done, not enabled, and must not
   be attempted until the production readiness review passes.

## 7. Files changed in Phase 4

- `server/src/lib/config.js`, `.env.example` — RPC defaults.
- `server/src/lib/monitor.js` — fail-closed receipt, paid-invoice
  second-payment ledger credit.
- `tests/paycrypto.test.js` — 9 new Phase 4 tests (28 total).
- `docs/TESTNET.md` — verified chain/RPC, acquisition guide,
  underpayment clarification, manual test checklist.
- `docs/TESTNET_REPORT_PHASE4.md` — this report.
