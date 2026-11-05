'use strict';
// Central configuration. No secret is ever given a real default value.
// Production activation is gated: PAYMENTS_LIVE=false means invoices can be
// created and testnet transfers can be monitored, but no real-money custody
// or automatic withdrawal is claimed or performed.
// Env-var hygiene for DB auth: Hostinger / copy-paste values often carry
// a trailing space or newline, which MySQL treats as part of the name
// and answers with ER_ACCESS_DENIED_ERROR. Identifiers are trimmed.
// DB_PASSWORD is deliberately NOT trimmed: it is used exactly as set,
// and the diagnostic in lib/db-diagnostics.js flags accidental
// leading/trailing whitespace instead of silently changing it.
function trimEnv(v) { return typeof v === 'string' ? v.trim() : v; }
const network = (process.env.BSC_NETWORK || 'testnet').toLowerCase();
const chainId = network === 'mainnet' ? 56 : 97;

const config = {
  port: Number(process.env.PORT || 3000),
  env: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  memoryDb: process.env.MEMORY_DB === 'true',
  db: {
    host: trimEnv(process.env.DB_HOST) || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: trimEnv(process.env.DB_USER) || 'paycrypto_user',
    password: process.env.DB_PASSWORD || '',
    database: trimEnv(process.env.DB_NAME) || 'paycrypto',
  },
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  network,
  chainId,
  rpcUrl:
    process.env.BSC_RPC_URL ||
    (network === 'mainnet'
      ? process.env.BSC_RPC_URL_MAINNET || 'https://bsc-dataseed.bnbchain.org'
      : process.env.BSC_RPC_URL_TESTNET || 'https://bsc-testnet-dataseed.bnbchain.org'),
  usdtContract: {
    mainnet: (process.env.USDT_CONTRACT_MAINNET || '0x55d398326f99059fF775485246999027B3197955').toLowerCase(),
    // Intentionally empty by default: testnet has no single canonical USDT.
    // The operator must verify a testnet token on testnet BscScan first.
    testnet: (process.env.USDT_CONTRACT_TESTNET || '').toLowerCase(),
  },
  usdtDecimals: 18,
  treasuryAddress: (process.env.TREASURY_ADDRESS || '').toLowerCase(),
  confirmations: Number(process.env.CONFIRMATIONS || 12),
  reorgDepth: Number(process.env.REORG_DEPTH || 12),
  invoiceExpiryMinutes: Number(process.env.INVOICE_EXPIRY_MINUTES || 60),
  minWithdrawalUsdt: process.env.MIN_WITHDRAWAL_USDT || '10',
  maxWithdrawalUsdt: process.env.MAX_WITHDRAWAL_USDT || '10000',
  withdrawalFeeUsdt: process.env.WITHDRAWAL_FEE_USDT || '1',
  paymentsLive: process.env.PAYMENTS_LIVE === 'true',
  autoSweep: process.env.AUTO_SWEEP === 'true',
  withdrawalAutoBroadcast: process.env.WITHDRAWAL_AUTO_BROADCAST === 'true',
  maintenanceMode: process.env.MAINTENANCE_MODE === 'true',
  emergencyPause: process.env.EMERGENCY_PAUSE === 'true',
};

config.usdtContractForNetwork = function () {
  return network === 'mainnet' ? this.usdtContract.mainnet : this.usdtContract.testnet;
};

module.exports = config;
