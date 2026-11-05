'use strict';
// Signer core — pure, testable logic. No HTTP, no file I/O, no keys
// read here. The keyProvider supplies wallets; in production it is
// built from the encrypted vault (services/signer/index.js), in tests
// from a test-only mnemonic. Private keys never leave this module
// except inside a signed transaction, and are never logged or returned.
const crypto = require('node:crypto');
const { ethers } = require('ethers');

const ERC20_ABI = [
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const iface = new ethers.Interface(ERC20_ABI);

function hmacSign(secret, method, path, timestamp, nonce, body) {
  return crypto.createHmac('sha256', secret).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
}

// Backend -> signer authentication: HMAC + timestamp freshness + nonce.
// A replayed request fails on nonce reuse; an old request fails on time.
function verifySignerRequest({ method, path, timestamp, nonce, body, signature, secret, seenNonces, nowMs = Date.now() }) {
  if (!signature || !timestamp || !nonce) return { ok: false, error: 'Missing auth headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > 300_000) return { ok: false, error: 'Request timestamp outside 5-minute window' };
  if (seenNonces.has(nonce)) return { ok: false, error: 'Nonce already used (replay)' };
  const expected = hmacSign(secret, method, path, String(timestamp), nonce, body);
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex')); } catch { ok = false; }
  if (!ok) return { ok: false, error: 'Invalid HMAC signature' };
  seenNonces.set(nonce, nowMs);
  return { ok: true };
}

function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }

function checkLimits(state, amountBaseUnits, { maxTxUsdt, dailyLimitUsdt }) {
  const { parseUsdt } = require('../../server/src/lib/money');
  const amount = BigInt(amountBaseUnits);
  if (amount <= 0n) throw new Error('Amount must be positive');
  if (amount > parseUsdt(maxTxUsdt)) throw new Error(`Amount exceeds per-transaction limit ${maxTxUsdt} USDT`);
  const today = dayKey();
  const used = BigInt(state.dailyTotals[today] || 0n);
  if (used + amount > parseUsdt(dailyLimitUsdt)) throw new Error(`Daily limit ${dailyLimitUsdt} USDT would be exceeded (already used ${used} base units today)`);
  return { today, used };
}

function validateSignRequest(req, cfg) {
  const { isValidBscAddress } = require('../../server/src/lib/wallet');
  if (!req.job_id || typeof req.job_id !== 'string' || req.job_id.length > 128) throw new Error('job_id is required (max 128 chars)');
  if (req.kind !== 'sweep' && req.kind !== 'withdrawal') throw new Error('kind must be sweep or withdrawal');
  if (!isValidBscAddress(req.to)) throw new Error('Invalid destination address');
  if (!req.amount_base_units || BigInt(req.amount_base_units) <= 0n) throw new Error('amount_base_units must be positive');
  if (cfg.maxTxUsdt) {
    const { parseUsdt } = require('../../server/src/lib/money');
    if (BigInt(req.amount_base_units) > parseUsdt(cfg.maxTxUsdt)) throw new Error(`Amount exceeds per-transaction limit ${cfg.maxTxUsdt} USDT`);
  }
  if (req.contract && req.contract.toLowerCase() !== cfg.usdtContract) throw new Error('Contract mismatch: signer only signs the configured USDT contract');
  if (!cfg.usdtContract) throw new Error('Signer USDT contract is not configured');
  if (req.kind === 'sweep') {
    // A sweep may ONLY go to the configured treasury. This is the
    // critical guard: a compromised backend cannot redirect a sweep
    // to an attacker address through the signer.
    if (req.to.toLowerCase() !== cfg.treasuryAddress) throw new Error('Sweep destination must be the configured treasury address');
    if (!Number.isInteger(req.deposit_index) || req.deposit_index < 0) throw new Error('Sweep requires a valid deposit_index');
  }
  if (req.kind === 'withdrawal') {
    if (!req.withdrawal_id) throw new Error('Withdrawal requires withdrawal_id');
    if (!req.approved_by) throw new Error('Withdrawal requires approved_by (admin approval reference)');
    if (req.to.toLowerCase() === cfg.treasuryAddress) throw new Error('Withdrawal destination must not be the treasury address itself');
  }
  return { job_id: req.job_id, kind: req.kind, to: ethers.getAddress(req.to), amount_base_units: BigInt(req.amount_base_units).toString() };
}

// Build a USDT transfer, checking gas and token balance first.
// Returns the unsigned tx + gas details, never a private key.
async function buildUsdtTransfer({ wallet, to, amountBaseUnits, cfg, provider }) {
  const data = iface.encodeFunctionData('transfer', [to, BigInt(amountBaseUnits)]);
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ? BigInt(fee.gasPrice) : 0n;
  const maxGasPrice = BigInt(Math.round(cfg.maxGasPriceGwei * 1e9));
  if (gasPrice > maxGasPrice) throw new Error(`Gas price ${gasPrice} wei exceeds cap ${maxGasPrice} wei (${cfg.maxGasPriceGwei} gwei) — refusing to sign`);
  const gasLimitRaw = await provider.estimateGas({ from: wallet.address, to: cfg.usdtContract, data });
  const gasLimit = (BigInt(gasLimitRaw) * 120n) / 100n; // 20% buffer
  const gasCost = gasLimit * gasPrice;
  const bnb = await provider.getBalance(wallet.address);
  if (BigInt(bnb) < gasCost) throw new Error(`Insufficient BNB for gas: have ${bnb} wei, need ${gasCost} wei`);
  const balData = iface.encodeFunctionData('balanceOf', [wallet.address]);
  const balRaw = await provider.call({ to: cfg.usdtContract, data: balData });
  const tokenBal = BigInt(new ethers.AbiCoder().decode(['uint256'], balRaw)[0]);
  if (tokenBal < BigInt(amountBaseUnits)) throw new Error(`Insufficient USDT balance: have ${tokenBal}, need ${amountBaseUnits}`);
  const nonce = await provider.getTransactionCount(wallet.address);
  return {
    tx: { to: cfg.usdtContract, data, value: 0n, gasLimit, gasPrice, chainId: cfg.chainId, nonce: Number(nonce) },
    gasCostWei: gasCost.toString(), gasPriceWei: gasPrice.toString(), gasLimit: gasLimit.toString(),
  };
}

function verifyReceipt(receipt, { contract, to, amountBaseUnits }) {
  if (!receipt) throw new Error('No receipt returned');
  if (receipt.status !== 1) throw new Error(`Transaction failed on-chain (status ${receipt.status})`);
  if (String(receipt.to).toLowerCase() !== String(contract).toLowerCase()) throw new Error('Receipt contract mismatch');
  // Logs: at least one Transfer log to the expected destination with
  // the expected amount, if logs are present.
  if (Array.isArray(receipt.logs) && receipt.logs.length) {
    const topic = ethers.id('Transfer(address,address,uint256)');
    const ok = receipt.logs.some((l) => l.topics && l.topics[0] === topic && ('0x' + l.topics[2].slice(26)).toLowerCase() === String(to).toLowerCase() && BigInt(l.data) === BigInt(amountBaseUnits));
    if (!ok) throw new Error('Receipt Transfer log does not match destination/amount');
  }
  return true;
}

// Sign (and optionally broadcast) one validated job. Idempotent by
// job_id: a second request for the same job returns the first result
// and never signs or broadcasts again.
async function signJob({ req, wallet, cfg, provider, state, audit }) {
  const validated = validateSignRequest(req, cfg);
  if (state.broadcasts[validated.job_id]) {
    audit({ event: 'sign.duplicate_job', job_id: validated.job_id, kind: validated.kind, result: 'returned_existing' });
    return { ...state.broadcasts[validated.job_id], duplicate: true };
  }
  const { today } = checkLimits(state, validated.amount_base_units, cfg);
  const { tx, gasCostWei, gasPriceWei, gasLimit } = await buildUsdtTransfer({ wallet, to: validated.to, amountBaseUnits: validated.amount_base_units, cfg, provider });
  const signed = await wallet.signTransaction(tx);
  const hash = ethers.keccak256(signed);
  let receipt = null;
  let broadcast = false;
  if (!cfg.dryRun) {
    const sent = await provider.broadcastTransaction(signed);
    const sentHash = sent.hash || hash;
    receipt = typeof sent.wait === 'function' ? await sent.wait() : await provider.waitForTransaction(sentHash, cfg.confirmations);
    verifyReceipt(receipt, { contract: cfg.usdtContract, to: validated.to, amountBaseUnits: validated.amount_base_units });
    broadcast = true;
    state.dailyTotals[today] = (BigInt(state.dailyTotals[today] || 0n) + BigInt(validated.amount_base_units)).toString();
  }
  const result = { job_id: validated.job_id, kind: validated.kind, from: wallet.address, to: validated.to, amount_base_units: validated.amount_base_units, tx_hash: hash, gas_cost_wei: gasCostWei, gas_price_wei: gasPriceWei, gas_limit: gasLimit, broadcast, dry_run: !!cfg.dryRun, receipt_status: receipt ? receipt.status : null };
  state.broadcasts[validated.job_id] = result;
  audit({ event: broadcast ? 'sign.broadcast' : 'sign.dry_run', job_id: validated.job_id, kind: validated.kind, from: wallet.address, to: validated.to, amount_base_units: validated.amount_base_units, tx_hash: hash, broadcast });
  return result;
}

module.exports = { hmacSign, verifySignerRequest, validateSignRequest, buildUsdtTransfer, verifyReceipt, signJob, dayKey, checkLimits };
