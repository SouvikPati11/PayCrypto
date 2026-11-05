'use strict';
// HD wallet — BIP39/BIP32/BIP44, BNB Smart Chain path m/44'/60'/0'/0/index.
// Security rules enforced by design:
//  - The seed phrase / private keys NEVER leave this module to a frontend,
//    are NEVER written to MySQL in plaintext, and are NEVER committed.
//  - init-wallet (scripts/init-wallet.js) encrypts the mnemonic with
//    AES-256-GCM into config/wallet.enc.json (gitignored) and prints only
//    the xpub + first address. Operators back that file up offline.
//  - The deposit-address derivation used at runtime can be watch-only:
//    deriveAddressFromXpub(xpub, index) needs no private key at all.
//  - The treasury wallet is SEPARATE: it must never reuse this seed.
//  - No custom cryptography is invented here: ethers (HDNodeWallet) +
//    Node crypto AES-256-GCM only.
const crypto = require('node:crypto');
const { ethers } = require('ethers');

const DERIVATION_BASE = "m/44'/60'/0'/0";
function derivationPath(index) {
  if (!Number.isInteger(index) || index < 0 || index > 2147483647) throw new Error('Invalid derivation index');
  return `${DERIVATION_BASE}/${index}`;
}

function deriveAddressFromMnemonic(mnemonic, index) {
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), undefined, derivationPath(index));
  return wallet.address;
}

function deriveAddressFromXpub(xpub, index) {
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid derivation index');
  const node = ethers.HDNodeWallet.fromExtendedKey(xpub);
  return node.deriveChild(index).address;
}

function getXpubFromMnemonic(mnemonic) {
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), undefined, DERIVATION_BASE);
  return wallet.neuter().extendedKey;
}

function isValidBscAddress(address) {
  try { return typeof address === 'string' && ethers.isAddress(address); } catch { return false; }
}

// Encryption key: 64 hex chars (32 bytes) from ENCRYPTION_KEY, or derived
// via scrypt from a passphrase for local tooling. Production: set the env var.
function encryptionKeyBytes() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (raw) return crypto.scryptSync(raw, 'paycrypto-wallet-salt', 32);
  throw new Error('ENCRYPTION_KEY is not configured');
}

function encryptSecret(plaintext) {
  const key = encryptionKeyBytes();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptSecret(blob) {
  const [ivHex, tagHex, dataHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted blob');
  const key = encryptionKeyBytes();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

function generateMnemonic() {
  return ethers.Mnemonic.entropyToPhrase(crypto.randomBytes(32));
}

module.exports = {
  DERIVATION_BASE, derivationPath, deriveAddressFromMnemonic,
  deriveAddressFromXpub, getXpubFromMnemonic, isValidBscAddress,
  encryptSecret, decryptSecret, generateMnemonic,
};
