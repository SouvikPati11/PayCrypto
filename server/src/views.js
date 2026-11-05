'use strict';
const config = require('./lib/config');

function layout(title, body, pageScript = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — PayCrypto</title><link rel="stylesheet" href="/css/style.css"></head><body>
<header><nav class="nav"><a class="logo" href="/">Pay<span>Crypto</span></a>
<a class="navlink" href="/features">Features</a><a class="navlink" href="/pricing">Pricing</a>
<a class="navlink" href="/docs">Docs</a><a class="navlink" href="/api-docs">API</a><a class="navlink" href="/faq">FAQ</a>
<span class="spacer"></span><a class="btn ghost" href="/login">Login</a><a class="btn" href="/register">Start free</a></nav></header>
<main>${body}</main>
<footer><div class="wrap"><span>© PayCrypto — USDT (BEP20) on BNB Smart Chain only.</span>
<span><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a> · <a href="/about">About</a></span></div></footer>
<script src="/js/app.js"></script>${pageScript ? `<script src="/js/${pageScript}"></script>` : ''}</body></html>`;
}

const hero = `<section class="hero"><h1>Accept USDT on BNB Smart Chain, without the custody guesswork.</h1>
<p>PayCrypto gives every merchant a unique BEP20 deposit address per invoice, verifies the transfer on-chain, credits an auditable ledger exactly once, and notifies your system by webhook. Testnet by default. Real money stays gated behind a security review.</p>
<p><a class="btn" href="/register">Create a merchant account</a> &nbsp; <a class="btn ghost" href="/docs">Read the docs</a></p>
<p class="small muted">Network: BNB Smart Chain only · Asset: USDT (BEP20) only · Contract (mainnet): <code class="mono">0x55d398326f99059fF775485246999027B3197955</code> · 18 decimals · Chain 56. Verify on BscScan before production activation.</p></section>`;

function featureCards() {
  const items = [
    ['Unique address per invoice', 'HD wallet derivation (BIP44 m/44\'/60\'/0\'/0/index) means no address reuse and no manual address book.'],
    ['On-chain verification', 'Transfer logs, receipt status and confirmations are checked server-side. Frontend claims are never trusted.'],
    ['Exactly-once ledger', 'Balances are derived from ledger entries. Duplicate tx hash + log index can never credit twice.'],
    ['Webhooks that retry', 'HMAC-signed invoice events with delivery logs and exponential-backoff retries.'],
    ['Treasury, separated', 'Deposit addresses and the treasury wallet are separate by design. Sweeps need manual review.'],
    ['Hostinger-friendly', 'One Node app + MySQL + cron. No permanently running worker is required.'],
  ];
  return `<div class="grid">${items.map(([t, d]) => `<div class="card"><h3>${t}</h3><p class="muted">${d}</p></div>`).join('')}</div>`;
}

const pages = {
  home: () => layout('Accept USDT BEP20 payments', hero + featureCards() + `<div class="card"><h3>How a payment flows</h3><p>1. Merchant creates an invoice &nbsp;→&nbsp; 2. PayCrypto assigns a unique HD deposit address &nbsp;→&nbsp; 3. Customer sends USDT (BEP20) &nbsp;→&nbsp; 4. The monitor verifies contract, address, amount and confirmations &nbsp;→&nbsp; 5. Ledger credited once &nbsp;→&nbsp; 6. Webhook delivered.</p><p class="muted small">Underpaid and overpaid invoices are kept as distinct states, not silently marked paid. Expired invoices never credit late payments automatically.</p></div>`),
  features: () => layout('Features', `<h1>Features</h1>${featureCards()}`),
  pricing: () => layout('Pricing', `<h1>Pricing</h1><div class="grid">
<div class="card"><h3>Starter — Free</h3><p class="kpi">$0</p><p class="muted">Testnet invoices, 1 merchant, community docs.</p></div>
<div class="card"><h3>Growth — $29/mo</h3><p class="kpi">$29</p><p class="muted">Higher limits, webhook retries, priority support. Billed separately from on-chain fees.</p></div>
<div class="card"><h3>Scale — Custom</h3><p class="kpi">Custom</p><p class="muted">Dedicated signing service, treasury review workflow, SLA.</p></div></div><p class="muted">On-chain BNB gas is always paid by the sender / treasury separately — it is never assumed to be free.</p>`),
  about: () => layout('About Us', `<h1>About PayCrypto</h1><p>PayCrypto is a payment gateway for USDT on BNB Smart Chain (BEP20) only. It is built for merchants who need verifiable payments, not screenshots: every credit traces to a transaction hash, a log index and a ledger entry.</p><p class="muted">This release is production-oriented code with testnet defaults and explicit safety gates. See docs/PRODUCTION_READINESS.md before enabling real funds.</p>`),
  contact: () => layout('Contact', `<h1>Contact</h1><form class="card" id="contactForm"><label>Name</label><input required><label>Email</label><input type="email" required><label>Message</label><textarea rows="4" required></textarea><button class="btn">Send message</button></form>`, 'contact.js'),
  faq: () => layout('FAQ', `<h1>FAQ</h1><div class="card"><h3>Which networks are supported?</h3><p>Only BNB Smart Chain, only USDT (BEP20). TRC20, ERC20 and other networks are not enabled.</p><h3>Do I need BNB for gas?</h3><p>Yes — customers pay BNB gas to send USDT, and sweeping deposit funds to treasury also needs BNB. PayCrypto never assumes a sweep is free.</p><h3>Can a payment be credited twice?</h3><p>No. The (tx_hash, log_index) pair and the ledger reference key are both unique.</p><h3>Is this live for real money?</h3><p>Not by default. PAYMENTS_LIVE=false until the reviews in docs/PRODUCTION_READINESS.md are complete.</p></div>`),
  docs: () => layout('Documentation', `<h1>Documentation</h1><div class="card"><p>Full docs live in the repository under <code>docs/</code>: installation, Hostinger deployment, HD wallet init, testnet testing, API reference and troubleshooting.</p><ul><li><a href="/api-docs">API documentation</a></li><li>Merchant flow: register → approve → create API key → create invoice → receive webhook</li><li>Admin flow: approve merchants → review withdrawals → review sweep jobs → monitor checkpoints</li></ul></div>`),
  apiDocs: () => layout('API Documentation', `<h1>API Documentation — v1</h1><div class="card"><p>Base: <code>/api/v1</code> · Auth: <code>Authorization: Bearer pk_test_… / pk_live_…</code> or session cookie for dashboards.</p>
<p><b>POST /api/v1/invoices</b> — create invoice (Idempotency-Key header supported)<br>
<b>GET /api/v1/invoices/:id</b> — invoice + status<br>
<b>GET /api/v1/invoices/:reference/public</b> — public pay-page status (limited fields)<br>
<b>GET /api/v1/transactions</b> — merchant transactions<br>
<b>GET /api/v1/balance</b> — derived available balance<br>
<b>POST /api/v1/withdrawals</b> — create withdrawal request (admin approval required)<br>
<b>GET /api/v1/withdrawals/:id</b> — withdrawal status<br>
<b>POST /api/v1/api-keys</b> / <b>POST /api/v1/webhooks</b> — merchant key &amp; webhook config</p>
<p class="muted">Webhooks: <code>X-PayCrypto-Signature: sha256=&lt;hmac-sha256(secret, raw-body)&gt;</code>. Verify the signature; never trust an unsigned payload.</p></div>`),
  terms: () => layout('Terms of Service', `<h1>Terms of Service</h1><div class="card"><p>PayCrypto provides payment-gateway software. Merchants remain responsible for their own legal, tax and licensing obligations for accepting crypto payments in their jurisdiction. On-chain transfers are irreversible. Testnet tokens have no value. Real-money use requires the production readiness review and the operator's own legal review — this template text does not replace legal advice.</p></div>`),
  privacy: () => layout('Privacy Policy', `<h1>Privacy Policy</h1><div class="card"><p>PayCrypto stores merchant account data, invoices, deposit addresses and transaction hashes needed to operate the gateway. Passwords are bcrypt-hashed, API keys are stored as hashes, TOTP secrets and webhook secrets are encrypted. No seed phrase or private key is stored in plaintext or committed to the repository. Contact the operator for data requests.</p></div>`),
  login: () => layout('Login', `<h1>Login</h1><form class="card" id="loginForm"><div id="msg"></div><label>Email</label><input id="email" type="email" required><label>Password</label><input id="password" type="password" required><label>Two-factor code (if enabled)</label><input id="totp"><button class="btn">Login</button><p class="small muted">No account? <a href="/register">Register as a merchant</a></p></form>`, 'login.js'),
  register: () => layout('Merchant Registration', `<h1>Merchant Registration</h1><form class="card" id="regForm"><div id="msg"></div><label>Business name</label><input id="business" required><label>Email</label><input id="email" type="email" required><label>Password (min 10 chars)</label><input id="password" type="password" required><label>Website (optional)</label><input id="website"><button class="btn">Create merchant account</button><p class="small muted">Accounts start as pending and need admin approval before live invoicing.</p></form>`, 'register.js'),
  merchant: () => layout('Merchant Dashboard', `<h1>Merchant Dashboard</h1><div class="grid"><div class="card"><div class="muted">Available balance</div><div class="kpi" id="bal">—</div></div><div class="card"><div class="muted">Invoices</div><div class="kpi" id="invCount">—</div></div><div class="card"><div class="muted">Network</div><div class="kpi" style="font-size:18px">${config.network.toUpperCase()} · Chain ${config.chainId}</div></div></div>
<div class="card"><h3>Create invoice</h3><form id="invForm"><div id="msg"></div><label>Amount (USDT)</label><input id="amount" required placeholder="10.50"><label>Customer email (optional)</label><input id="custEmail" type="email"><button class="btn">Create invoice</button></form><div id="invResult"></div></div>
<div class="card"><h3>Invoices</h3><div id="invTable"></div></div>
<div class="card"><h3>Withdrawals</h3><form id="wdForm"><label>Destination (BSC address)</label><input id="dest" required placeholder="0x…"><label>Amount (USDT)</label><input id="wdAmount" required><button class="btn">Request withdrawal</button><div id="wdMsg"></div></form><div id="wdTable"></div></div>
<div class="card"><h3>API keys &amp; webhooks</h3><p class="muted small">Use the API below. Keys are shown once — store them safely.</p><button class="btn ghost" id="createKeyBtn">Create API key</button> <span id="newKey"></span><div id="keyTable"></div>
<form id="whForm" style="margin-top:16px"><label>Webhook URL</label><input id="whUrl" required placeholder="https://your-site.com/paycrypto-webhook"><button class="btn ghost">Save webhook</button></form><div id="whTable"></div></div>
`, 'merchant.js'),
  admin: () => layout('Admin Dashboard', `<h1>Admin Dashboard</h1><div class="grid"><div class="card"><div class="muted">Merchants</div><div class="kpi" id="mCount">—</div></div><div class="card"><div class="muted">Invoices</div><div class="kpi" id="iCount">—</div></div><div class="card"><div class="muted">Pending withdrawals</div><div class="kpi" id="wCount">—</div></div><div class="card"><div class="muted">Safety gates</div><p class="small">Live payments: <b>${config.paymentsLive ? 'ON' : 'OFF'}</b> · Auto sweep: <b>${config.autoSweep ? 'ON' : 'OFF'}</b> · Auto broadcast: <b>${config.withdrawalAutoBroadcast ? 'ON' : 'OFF'}</b><br>Emergency pause: <b>${config.emergencyPause ? 'ON' : 'OFF'}</b></p></div></div>
<div class="card"><h3>Merchants</h3><div id="mTable"></div></div><div class="card"><h3>Withdrawals</h3><div id="wTable"></div></div><div class="card"><h3>Audit log</h3><div id="aTable"></div></div>
`, 'admin.js'),
};

function payPage(invoice) {
  const body = invoice
    ? `<h1>Pay invoice ${invoice.reference}</h1><div class="card"><p>Send exactly <b>${invoice.amount_usdt} USDT</b> on <b>BNB Smart Chain (BEP20)</b> to:</p><p class="mono" style="font-size:18px">${invoice.deposit_address || 'Address will appear once assigned'}</p><p>Status: <span class="pill">${invoice.status}</span> · Expires: ${invoice.expires_at || '—'}</p><p class="small muted">Send only USDT (BEP20) from the configured contract. Sending another token or network can lose funds. This page polls the server status — it never trusts a browser claim.</p><div id="live"></div><div id="payData" data-reference="${invoice.reference}"></div></div>`
    : `<h1>Invoice not found</h1><p class="muted">Check the reference and try again.</p>`;
  return layout('Pay invoice', body, invoice ? 'pay.js' : '');
}

module.exports = { layout, pages, payPage };
