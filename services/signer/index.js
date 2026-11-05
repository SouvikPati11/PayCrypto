'use strict';
// Signer service entry point — runs on a SEPARATE host from Hostinger.
// It loads the encrypted vault (config/signer-vault.enc.json, 0600,
// gitignored) using SIGNER_VAULT_KEY from the signer host's environment
// only, decrypts it into memory, and never writes keys back to disk,
// never logs them, and never serves them over HTTP.
// Create the vault on the signer host only:
//   SIGNER_VAULT_KEY=<64-hex> node scripts/init-signer-vault.js
// Start (signer host only):
//   SIGNER_API_SECRET=<32+ chars> SIGNER_TREASURY_ADDRESS=0x... \
//   SIGNER_USDT_CONTRACT=<testnet contract> SIGNER_DRY_RUN=true \
//   node services/signer/index.js
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { signerConfig } = require('./config');
const { createSignerApp } = require('./server');

function decryptVault(blob, keyHex) {
  // Format: iv:tag:data (hex), AES-256-GCM, same construction as wallet.js.
  const [ivHex, tagHex, dataHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid signer vault format');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('SIGNER_VAULT_KEY must be 64 hex characters');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8'));
}

function main() {
  const cfg = signerConfig();
  if (!cfg.usdtContract) { console.error('SIGNER_USDT_CONTRACT is required (verified testnet token, or mainnet contract only with SIGNER_ALLOW_MAINNET=true).'); process.exit(1); }
  if (!cfg.treasuryAddress) { console.error('SIGNER_TREASURY_ADDRESS is required.'); process.exit(1); }
  if (!fs.existsSync(cfg.vaultFile)) {
    console.error(`Signer vault not found at ${cfg.vaultFile}. Create it on THIS host only with: SIGNER_VAULT_KEY=<64-hex> node scripts/init-signer-vault.js`);
    process.exit(1);
  }
  if (!cfg.vaultKey) { console.error('SIGNER_VAULT_KEY is required on the signer host.'); process.exit(1); }
  const vault = decryptVault(fs.readFileSync(cfg.vaultFile, 'utf8').trim(), cfg.vaultKey);
  if (!vault.deposit_mnemonic || !vault.treasury_private_key) { console.error('Signer vault is missing deposit_mnemonic or treasury_private_key.'); process.exit(1); }
  const keyProvider = {
    async getDepositWallet(index) {
      if (!Number.isInteger(index) || index < 0) throw new Error('Invalid deposit_index');
      return ethers.HDNodeWallet.fromPhrase(vault.deposit_mnemonic.trim(), undefined, `m/44'/60'/0'/0/${index}`);
    },
    async getTreasuryWallet() { return new ethers.Wallet(vault.treasury_private_key.trim()); },
  };
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const state = { dailyTotals: {}, broadcasts: {} };
  if (cfg.stateFile && fs.existsSync(cfg.stateFile)) {
    try { const s = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); Object.assign(state, { dailyTotals: s.dailyTotals || {}, broadcasts: s.broadcasts || {} }); } catch {}
  }
  const audit = (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    console.log(line);
    if (cfg.auditFile) { try { fs.appendFileSync(cfg.auditFile, line + '\n'); } catch {} }
    if (cfg.stateFile) { try { fs.writeFileSync(cfg.stateFile, JSON.stringify({ dailyTotals: Object.fromEntries(Object.entries(state.dailyTotals).map(([k, v]) => [k, v.toString()])), broadcasts: state.broadcasts }, null, 2)); } catch {} }
  };
  const app = createSignerApp({ cfg, keyProvider, provider, state, audit });
  app.listen(cfg.port, cfg.host, () => console.log(`PayCrypto signer listening on ${cfg.host}:${cfg.port} (${cfg.network}, chain ${cfg.chainId}, dry_run=${cfg.dryRun})`));
}

if (require.main === module) main();
module.exports = { decryptVault };
