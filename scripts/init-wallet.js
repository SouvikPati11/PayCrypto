'use strict';
// HD wallet initialization — run ONCE, on a secure offline machine if possible.
//  node scripts/init-wallet.js
// What it does:
//  - Generates a fresh BIP39 mnemonic (or uses WALLET_MNEMONIC from a secure
//    local env var — never paste a production mnemonic into chat or a file).
//  - Encrypts it with AES-256-GCM (ENCRYPTION_KEY) into config/wallet.enc.json
//    (gitignored) and prints ONLY the xpub + first address.
//  - Prints the mnemonic ONCE to the terminal so the operator can back it
//    up offline. It is never written to the repo, never logged, never sent.
//  - The treasury wallet must be a DIFFERENT wallet — never reuse this seed.
// If ENCRYPTION_KEY is missing, this script refuses to run.
const fs = require('node:fs');
const path = require('node:path');
const { generateMnemonic, getXpubFromMnemonic, deriveAddressFromMnemonic, encryptSecret } = require('../server/src/lib/wallet');

function main() {
  if (!process.env.ENCRYPTION_KEY) { console.error('Refusing to run: ENCRYPTION_KEY is not set.'); process.exitCode = 2; return; }
  const mnemonic = process.env.WALLET_MNEMONIC || generateMnemonic();
  const xpub = getXpubFromMnemonic(mnemonic);
  const first = deriveAddressFromMnemonic(mnemonic, 0);
  const outDir = path.join(__dirname, '..', 'config');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'wallet.enc.json');
  // PHASE 1: never silently overwrite an existing wallet. Rotating a seed
  // must be a deliberate act, or old deposit addresses become unrecoverable.
  if (fs.existsSync(outFile) && process.env.WALLET_OVERWRITE !== 'true') {
    console.error('Refusing to overwrite existing', outFile, '— set WALLET_OVERWRITE=true only for a deliberate rotation (see docs/WALLET.md).');
    process.exitCode = 2; return;
  }
  fs.writeFileSync(outFile, JSON.stringify({ xpub, encrypted_mnemonic: encryptSecret(mnemonic), created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log('HD wallet initialized.');
  console.log('XPUB (safe to store in system_settings.wallet_xpub for watch-only derivation):', xpub);
  console.log('First deposit address (index 0):', first);
  console.log('Encrypted backup written to:', outFile, '(gitignored — back it up offline, never commit it)');
  console.log('\n=== WRITE THIS MNEMONIC DOWN OFFLINE, THEN CLEAR THE TERMINAL ===');
  console.log(mnemonic);
  console.log('=== END MNEMONIC — never share it, never reuse it for treasury ===\n');
}
if (require.main === module) main();
module.exports = { main };
