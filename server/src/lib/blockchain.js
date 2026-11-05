'use strict';
// BNB Smart Chain USDT (BEP20) monitoring primitives — pure where possible.
// Only USDT, only BNB Smart Chain, only the configured contract address.
// A transfer from any other contract is not USDT for this gateway, however
// similar its name or symbol looks.
const { ethers } = require('ethers');

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

// Decode one log. Returns null when it is not a USDT Transfer to check.
function parseTransferLog(log, expectedContract) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (String(log.address).toLowerCase() !== String(expectedContract).toLowerCase()) return null;
  if (log.topics[0] !== TRANSFER_TOPIC) return null;
  try {
    const from = ethers.getAddress('0x' + log.topics[1].slice(26));
    const to = ethers.getAddress('0x' + log.topics[2].slice(26));
    const value = BigInt(log.data);
    return { from, to, value, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber };
  } catch { return null; }
}

function isCanonicalTokenContract(address, expectedContract) {
  return !!address && !!expectedContract && String(address).toLowerCase() === String(expectedContract).toLowerCase();
}

// Verify a token contract on-chain: it must answer name/symbol/decimals
// and match the expected values. Callers must fail closed on any error.
async function verifyTokenContract(provider, contractAddress, { symbol = 'USDT', decimals = 18 } = {}) {
  const contract = new ethers.Contract(contractAddress, ERC20_ABI, provider);
  const [name, sym, dec] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()]);
  if (sym !== symbol || Number(dec) !== decimals) {
    throw new Error(`Token contract mismatch: symbol=${sym} decimals=${dec} (expected ${symbol}/${decimals}, name=${name})`);
  }
  return { name, symbol: sym, decimals: Number(dec) };
}

async function validateChainId(provider, expectedChainId) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(expectedChainId)) {
    throw new Error(`Chain ID mismatch: provider=${net.chainId}, expected=${expectedChainId}`);
  }
  return true;
}

module.exports = { TRANSFER_TOPIC, ERC20_ABI, parseTransferLog, isCanonicalTokenContract, verifyTokenContract, validateChainId };
