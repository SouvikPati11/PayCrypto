'use strict';
// Create the signer vault on the SIGNER HOST ONLY — never on Hostinger,
// never in the repository, never over chat.
// The vault file is AES-256-GCM encrypted, 0600, gitignored.
// Inputs come from the signer host's environment only:
//   SIGNER_VAULT_KEY=<64 hex>  (required, encrypts the vault)
//   DEPOSIT_MNEMONIC=<words>   (optional; if empty, a fresh one is generated and printed ONCE — back it up offline immediately)
//   TREASURY_PRIVATE_KEY=0x... (optional; if empty, a fresh random wallet is generated; its address is printed, the key is NOT printed — back up the vault file itself)
//   SIGNER_VAULT_FILE=<path>   (optional, default config/signer-vault.enc.json)
// Refuses to overwrite an existing vault unless SIGNER_VAULT_OVERWRITE=true.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { generateMnemonic, getXpubFromMnemonic } = require('../server/src/lib/wallet');

function main() {
  const keyHex = process.env.SIGNER_VAULT_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) { console.error('SIGNER_VAULT_KEY must be 64 hex characters.'); process.exitCode = 2; return; }
  const outFile = process.env.SIGNER_VAULT_FILE || path.join(__dirname, '..', 'config', 'signer-vault.enc.json');
  if (fs.existsSync(outFile) && process.env.SIGNER_VAULT_OVERWRITE !== 'true') {
    console.error(`Refusing to overwrite existing ${outFile} — set SIGNER_VAULT_OVERWRITE=true only for a deliberate rotation (see docs/SIGNING_SERVICE.md).`);
    process.exitCode = 2; return;
  }
  let mnemonic = (process.env.DEPOSIT_MNEMONIC || '').trim();
  let generatedMnemonic = false;
  if (!mnemonic) { mnemonic = generateMnemonic(); generatedMnemonic = true; }
  let treasuryKey = (process.env.TREASURY_PRIVATE_KEY || '').trim();
  if (!treasuryKey) treasuryKey = ethers.Wallet.createRandom().privateKey;
  const vault = JSON.stringify({ deposit_mnemonic: mnemonic, treasury_private_key: treasuryKey, created_at: new Date().toISOString() });
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(vault, 'utf8'), cipher.final()]);
  const blob = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, blob, { mode: 0o600 });
  const treasury = new ethers.Wallet(treasuryKey);
  console.log('Signer vault written:', outFile, '(0600, encrypted, gitignored)');
  console.log('Deposit xpub:', getXpubFromMnemonic(mnemonic));
  console.log('Deposit address index 0:', ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0").address);
  console.log('Treasury address:', treasury.address);
  if (generatedMnemonic) {
    console.log('--- GENERATED DEPOSIT MNEMONIC (print once, back up offline, then clear this terminal) ---');
    console.log(mnemonic);
    console.log('--- END MNEMONIC ---');
    console.log('The treasury private key was NOT printed. Back up the encrypted vault file itself, plus this mnemonic, in separate offline locations.');
  } else {
    console.log('Deposit mnemonic was supplied via environment and is NOT printed. Treasury private key is NOT printed.');
  }
}
if (require.main === module) main();
module.exports = { main };
