'use strict';
// Signer service configuration — read ONLY from the signer host's own
// environment, never from the PayCrypto web app's .env, never from the
// repository. Production signing keys are NOT in this file and must
// never be added to it, to .env, or to Hostinger application files.
// See docs/SIGNING_SERVICE.md for the deployment model.
const path = require('node:path');

const network = (process.env.SIGNER_NETWORK || 'testnet').toLowerCase();
const chainId = network === 'mainnet' ? 56 : 97;
const allowMainnet = process.env.SIGNER_ALLOW_MAINNET === 'true';

function signerConfig() {
  if (network === 'mainnet' && !allowMainnet) {
    throw new Error('Signer refuses mainnet: set SIGNER_ALLOW_MAINNET=true only after the independent security review and production-readiness checklist pass. Testnet is the default.');
  }
  const apiSecret = process.env.SIGNER_API_SECRET || '';
  if (!apiSecret || apiSecret.length < 32) {
    throw new Error('SIGNER_API_SECRET must be set on the signer host and be at least 32 characters. It is the backend-to-signer HMAC secret, not a signing key.');
  }
  return {
    host: process.env.SIGNER_HOST || '127.0.0.1',
    port: Number(process.env.SIGNER_PORT || 4100),
    network,
    chainId,
    allowMainnet,
    rpcUrl: process.env.SIGNER_RPC_URL || (network === 'mainnet' ? 'https://bsc-dataseed.bnbchain.org' : 'https://bsc-testnet-dataseed.bnbchain.org'),
    usdtContract: (process.env.SIGNER_USDT_CONTRACT || '').toLowerCase(),
    treasuryAddress: (process.env.SIGNER_TREASURY_ADDRESS || '').toLowerCase(),
    apiSecret,
    dryRun: process.env.SIGNER_DRY_RUN !== 'false', // default: sign, do NOT broadcast. Operator sets false explicitly for manual testnet testing.
    maxGasPriceGwei: Number(process.env.SIGNER_MAX_GAS_PRICE_GWEI || 5),
    maxTxUsdt: process.env.SIGNER_MAX_TX_USDT || '10000',
    dailyLimitUsdt: process.env.SIGNER_DAILY_LIMIT_USDT || '10000',
    minSweepUsdt: process.env.SIGNER_MIN_SWEEP_USDT || '10',
    confirmations: Number(process.env.SIGNER_CONFIRMATIONS || 12),
    vaultFile: process.env.SIGNER_VAULT_FILE || path.join(__dirname, '..', '..', 'config', 'signer-vault.enc.json'),
    vaultKey: process.env.SIGNER_VAULT_KEY || '',
    stateFile: process.env.SIGNER_STATE_FILE || '',
    auditFile: process.env.SIGNER_AUDIT_FILE || '',
  };
}

module.exports = { signerConfig };
