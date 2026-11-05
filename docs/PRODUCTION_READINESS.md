# Production Readiness Review — must pass before real money

Do not set `PAYMENTS_LIVE=true`, `AUTO_SWEEP=true` or
`WITHDRAWAL_AUTO_BROADCAST=true` until every item below is checked
and signed off by the operator. This file is a gate, not a promise.

- [ ] Security review: code review, dependency audit (`npm audit`),
      penetration test of auth, admin RBAC, API keys, webhooks.
- [ ] Key management: HD seed backed up offline, xpub-only web
      server, treasury keys in a dedicated signing service / HSM —
      never on the web server, never in `.env` on shared hosting.
- [ ] Mainnet contract re-verified on BscScan on activation day:
      `0x55d398326f99059fF775485246999027B3197955`, 18 decimals.
- [ ] RPC plan: at least one fallback RPC, rate-limit handling,
      checkpoint monitoring alert if the monitor has not advanced.
- [ ] BNB gas funding: treasury + sweep gas budget, failure alerts,
      no sweep assumed free.
- [ ] Withdrawal policy: limits, fees, manual approval, dual control
      for large amounts, daily caps.
- [ ] Database backups: automated MySQL backups, restore tested.
- [ ] Legal / compliance: merchant's own licensing, tax, AML/KYC
      obligations for their jurisdiction — PayCrypto is software,
      not legal advice.
- [ ] Incident plan: emergency pause procedure, key rotation
      procedure (docs/WALLET.md), customer communication template.
- [ ] Monitoring: admin overview checked daily, failed transactions,
      pending withdrawals, orphaned transfers reviewed.

## Known v1 gaps (honest, not hidden)

- Automatic sweep / withdrawal broadcast is not implemented as an
  on-chain signer. It requires a dedicated signing service, which
  is out of scope for shared hosting and is the main VPS migration
  item.
- Webhook delivery is queued by the monitor; a production cron
  delivery worker (pattern in docs/API.md) should be added.
- TOTP secrets and webhook secrets are AES-256-GCM encrypted with
  `ENCRYPTION_KEY`; in production that key should live in a proper
  secrets manager, not a shared-hosting `.env` alone.
