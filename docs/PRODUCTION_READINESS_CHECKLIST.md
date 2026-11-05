# Final Production-Readiness Checklist (Phase 5 completion)

**Status: NOT READY FOR MAINNET. Mainnet is NOT activated.**
`PAYMENTS_LIVE=false`, `AUTO_SWEEP=false`,
`WITHDRAWAL_AUTO_BROADCAST=false` in code and in `.env.example`.
This checklist is the gate, not a claim that the gate is passed.

## A. Code & tests — done (automated)

- [x] Phase 1 security audit + fixes (CSRF, session revocation,
  expired-invoice credit, withdrawal accounting, orphaned txs,
  production-secret refusal, wallet overwrite guard, SQL allowlist,
  XSS escaping) — `docs/SECURITY_AUDIT_PHASE1.md`
- [x] Phase 2 CSP, per-key rate limiting, webhook delivery worker,
  admin button fix, docs verification — `docs/SECURITY_AUDIT_PHASE2.md`
- [x] Phase 3 deployment preparation (MySQL, migrations, cron,
  env checklist) — `docs/DEPLOYMENT_CHECKLIST.md` (preparation
  only, no deployment performed by the agent)
- [x] Phase 4 testnet verification (chain 97, RPC, isolation,
  payment scenarios) — `docs/TESTNET_REPORT_PHASE4.md`
- [x] Phase 5 signer service (isolated vault, HMAC, limits, gas,
  audit, replay/duplicate protection) — `docs/SIGNING_SERVICE.md`
- [x] Automated tests: **34/34 pass** (money, ledger, HD wallet,
  blockchain, webhooks, auth, store, CSRF, sessions, rate limiting,
  webhook delivery, testnet scenarios, signer scenarios)
- [x] No TRC20/ERC20 added. USDT BEP20 on BSC only.
- [x] No production keys, mnemonics, passwords or secrets committed.

## B. Manual testing — still required (operator)

- [ ] CI workflow added manually via `docs/CI_MANUAL_ADD.md`
  (GitHub App cannot add workflow files — see Phase 2 report).
- [ ] Hostinger deployment completed from
  `docs/DEPLOYMENT_CHECKLIST.md` (DB, app, `.env`, migrations,
  seed, health check, both cron jobs).
- [ ] Live testnet payment end-to-end (Phase 4 §6, items 1–3):
  invoice → test-token payment → monitor → `paid` → single
  ledger credit → webhook log → no second credit on re-run.
- [ ] Live testnet sweep + withdrawal via the signer
  (Phase 5, `docs/SIGNING_SERVICE.md` §10): dry-run first, then
  broadcast, verify on testnet BscScan, verify sweep job and
  withdrawal ledger debit.
- [ ] Signer recovery test: restore the vault on a fresh host,
  dry-run, confirm index-0 address matches.
- [ ] Webhook delivery on a real merchant endpoint (not just
  the mock worker test).

## C. Security & operations — still required before mainnet

- [ ] **Independent security review** by a qualified reviewer
  who did not write this code. This checklist does not replace it.
- [ ] KMS-backed signing (or HSM) implemented and tested, replacing
  the VPS vault keyProvider — see `docs/SIGNING_SERVICE.md` §5.
- [ ] Signer host hardened: private network only, firewall
  allowlist, no password SSH, automatic updates, audit-log
  monitoring and alerting.
- [ ] Key rotation schedule written and first rotation rehearsed
  on testnet (see `docs/SIGNING_SERVICE.md` §6).
- [ ] Incident response plan written: signer stop procedure,
  compromise rotation, on-chain verification of suspect txs.
- [ ] Legal / tax / licensing review for accepting crypto payments
  in each merchant jurisdiction (operator's responsibility —
  see Terms of Service; this code is not legal advice).
- [ ] Mainnet contract re-verified on BscScan at activation time
  (`0x55d398326f99059fF775485246999027B3197955`, 18 decimals,
  chain 56) — do not rely on a months-old verification.
- [ ] Production `.env` set only in Hostinger / signer host
  environments, with production secrets ≥32 chars and a 64-hex
  `ENCRYPTION_KEY`, and `PAYMENTS_LIVE` flipped only after every
  item above is checked, by an explicit operator decision.

## D. Explicitly NOT done

- Mainnet payments are not enabled, not tested with real funds,
  and not claimed secure for production.
- No automatic sweep or withdrawal broadcast exists in any cron
  or web route. Manual operator scripts are the only broadcast path.
- No independent security review has been performed.
- No Hostinger deployment, no signer host deployment, and no
  live testnet transaction has been performed by the agent.
