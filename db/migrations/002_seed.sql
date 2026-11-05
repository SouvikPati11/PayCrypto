-- Seed: default system settings only. No users, no keys, no secrets.
-- Mainnet USDT contract: 0x55d398326f99059fF775485246999027B3197955 (18 decimals).
-- Testnet contract is intentionally left empty — set it only after verifying
-- a testnet token on testnet BscScan (see docs/TESTNET.md).
INSERT INTO system_settings (`key`, `value`) VALUES
  ('network', 'testnet'),
  ('chain_id', '97'),
  ('usdt_contract_mainnet', '0x55d398326f99059fF775485246999027B3197955'),
  ('usdt_contract_testnet', ''),
  ('confirmations', '12'),
  ('invoice_expiry_minutes', '60'),
  ('min_withdrawal_usdt', '10'),
  ('max_withdrawal_usdt', '10000'),
  ('withdrawal_fee_usdt', '1'),
  ('maintenance_mode', 'false'),
  ('emergency_pause', 'false')
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`);
