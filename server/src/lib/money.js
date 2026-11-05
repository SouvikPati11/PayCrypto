'use strict';
// USDT on BNB Smart Chain uses 18 decimals. All accounting is done in
// base units (BigInt) and stored in MySQL as DECIMAL(38,0) strings.
// Never use floating point for money: parse -> BigInt -> format only for display.
const DECIMALS = 18n;
const UNIT = 10n ** DECIMALS;

function parseUsdt(input) {
  if (typeof input === 'bigint') return input;
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error('Invalid USDT amount');
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * UNIT + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0');
}

function formatUsdt(baseUnits) {
  const v = typeof baseUnits === 'bigint' ? baseUnits : BigInt(String(baseUnits || '0'));
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

function isValidUsdtAmount(input) {
  try { const v = parseUsdt(input); return v > 0n; } catch { return false; }
}

module.exports = { DECIMALS, UNIT, parseUsdt, formatUsdt, isValidUsdtAmount };
