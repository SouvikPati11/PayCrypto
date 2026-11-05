-- PayCrypto schema — MySQL 8 / MariaDB compatible.
-- Accounting rule: balances are derived from ledger_entries, never stored
-- as an editable column. Amounts are USDT base units (18 decimals) in
-- DECIMAL(38,0). Unique constraints are the duplicate-payment defence.
CREATE TABLE IF NOT EXISTS merchants (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  business_name VARCHAR(191) NOT NULL,
  contact_email VARCHAR(191) NOT NULL,
  website VARCHAR(255) NULL,
  status ENUM('pending','approved','suspended','rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_merchants_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(191) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('merchant','admin','super_admin','support') NOT NULL DEFAULT 'merchant',
  merchant_id BIGINT UNSIGNED NULL,
  totp_secret_encrypted TEXT NULL,
  totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE SET NULL,
  INDEX idx_users_role (role)
) ENGINE=InnoDB;
ALTER TABLE merchants ADD CONSTRAINT fk_merchants_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS merchant_profiles (
  merchant_id BIGINT UNSIGNED PRIMARY KEY,
  legal_name VARCHAR(191) NULL,
  country VARCHAR(100) NULL,
  address TEXT NULL,
  support_email VARCHAR(191) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(191) NOT NULL DEFAULT 'Default',
  key_prefix VARCHAR(32) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  live TINYINT(1) NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  INDEX idx_api_keys_merchant (merchant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deposit_addresses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NULL UNIQUE,
  address VARCHAR(42) NOT NULL UNIQUE,
  derivation_index BIGINT UNSIGNED NOT NULL UNIQUE,
  network VARCHAR(32) NOT NULL DEFAULT 'testnet',
  status ENUM('assigned','used') NOT NULL DEFAULT 'assigned',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  INDEX idx_deposit_merchant (merchant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(64) NOT NULL UNIQUE,
  customer_email VARCHAR(191) NULL,
  amount_base_units DECIMAL(38,0) NOT NULL,
  currency VARCHAR(16) NOT NULL DEFAULT 'USDT',
  network VARCHAR(32) NOT NULL DEFAULT 'BSC',
  status ENUM('pending','confirming','paid','underpaid','overpaid','expired','cancelled','failed') NOT NULL DEFAULT 'pending',
  deposit_address_id BIGINT UNSIGNED NULL,
  deposit_address VARCHAR(42) NULL,
  expires_at TIMESTAMP NULL,
  idempotency_key VARCHAR(191) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (deposit_address_id) REFERENCES deposit_addresses(id) ON DELETE SET NULL,
  UNIQUE KEY uq_invoice_merchant_idem (merchant_id, idempotency_key),
  INDEX idx_invoices_merchant_status (merchant_id, status),
  INDEX idx_invoices_reference (reference)
) ENGINE=InnoDB;
ALTER TABLE deposit_addresses ADD CONSTRAINT fk_deposit_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INT NOT NULL,
  block_number BIGINT UNSIGNED NOT NULL,
  block_hash VARCHAR(66) NULL,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  token_contract VARCHAR(42) NOT NULL,
  amount_base_units DECIMAL(38,0) NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  merchant_id BIGINT UNSIGNED NULL,
  status ENUM('pending','confirming','confirmed','failed','orphaned') NOT NULL DEFAULT 'pending',
  confirmations INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tx_log (tx_hash, log_index),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE SET NULL,
  INDEX idx_chain_to (to_address),
  INDEX idx_chain_invoice (invoice_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  blockchain_tx_id BIGINT UNSIGNED NULL,
  withdrawal_id BIGINT UNSIGNED NULL,
  entry_type ENUM('credit','debit') NOT NULL,
  amount_base_units DECIMAL(38,0) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  reference_key VARCHAR(191) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  INDEX idx_ledger_merchant (merchant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id BIGINT UNSIGNED NOT NULL,
  destination_address VARCHAR(42) NOT NULL,
  amount_base_units DECIMAL(38,0) NOT NULL,
  fee_base_units DECIMAL(38,0) NOT NULL DEFAULT 0,
  net_base_units DECIMAL(38,0) NOT NULL DEFAULT 0,
  status ENUM('pending','approved','rejected','awaiting_broadcast','broadcast','confirmed','failed') NOT NULL DEFAULT 'pending',
  tx_hash VARCHAR(66) NULL UNIQUE,
  admin_note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  INDEX idx_withdrawals_merchant_status (merchant_id, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS treasury_transactions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  direction ENUM('in','out') NOT NULL,
  amount_base_units DECIMAL(38,0) NOT NULL,
  tx_hash VARCHAR(66) NULL UNIQUE,
  from_address VARCHAR(42) NULL,
  to_address VARCHAR(42) NULL,
  purpose VARCHAR(64) NOT NULL DEFAULT 'sweep',
  status ENUM('pending','confirmed','failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sweep_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_key VARCHAR(191) NOT NULL UNIQUE,
  treasury_address VARCHAR(42) NOT NULL,
  status ENUM('pending','review','approved','executing','completed','failed') NOT NULL DEFAULT 'pending',
  tx_hash VARCHAR(66) NULL UNIQUE,
  total_base_units DECIMAL(38,0) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS webhooks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_id BIGINT UNSIGNED NOT NULL,
  url VARCHAR(500) NOT NULL,
  secret_encrypted TEXT NOT NULL,
  events JSON NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS webhook_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  webhook_id BIGINT UNSIGNED NOT NULL,
  merchant_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  event VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  signature VARCHAR(128) NOT NULL DEFAULT '',
  status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMP NULL,
  response_code INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE,
  INDEX idx_webhook_logs_merchant (merchant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_type VARCHAR(32) NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NULL,
  entity_id BIGINT UNSIGNED NULL,
  details JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_action (action)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_settings (
  `key` VARCHAR(191) PRIMARY KEY,
  `value` TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS login_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  expires_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS monitor_checkpoints (
  network VARCHAR(32) PRIMARY KEY,
  last_block_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_block_hash VARCHAR(66) NOT NULL DEFAULT '',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
