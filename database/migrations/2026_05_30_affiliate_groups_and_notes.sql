-- Affiliate Procurement v2 foundations:
-- - User-defined account groups
-- - Group-level prompt configs
-- - Group-scoped prospect assignments
-- - Special notes
-- - Prospect type + follower count
-- - Minimum affiliate follower threshold

CREATE TABLE IF NOT EXISTS account_groups (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_account_group_name (user_id, name),
  INDEX idx_account_groups_user_id (user_id)
);

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tiktok_accounts' AND COLUMN_NAME = 'group_id'
  ),
  'SELECT 1',
  'ALTER TABLE tiktok_accounts ADD COLUMN group_id INT NULL AFTER user_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tiktok_accounts' AND INDEX_NAME = 'idx_tiktok_accounts_group_id'
  ),
  'SELECT 1',
  'CREATE INDEX idx_tiktok_accounts_group_id ON tiktok_accounts(group_id)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tiktok_accounts'
      AND COLUMN_NAME = 'group_id'
      AND REFERENCED_TABLE_NAME = 'account_groups'
  ),
  'SELECT 1',
  'ALTER TABLE tiktok_accounts ADD CONSTRAINT fk_tiktok_accounts_group_id FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE SET NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS group_prompt_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  group_id INT NOT NULL,
  ai_prompt TEXT DEFAULT NULL,
  example_dm TEXT DEFAULT NULL,
  example_comment TEXT DEFAULT NULL,
  brand_voice TEXT DEFAULT NULL,
  affiliate_dm_prompt TEXT DEFAULT NULL,
  affiliate_invitation_text TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE CASCADE,
  UNIQUE KEY unique_group_prompt_config (user_id, group_id),
  INDEX idx_group_prompt_user_group (user_id, group_id)
);

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'min_affiliate_followers'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN min_affiliate_followers INT DEFAULT 2000 AFTER affiliate_dm_eds_threshold'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'follower_count'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN follower_count BIGINT NULL AFTER bio_scraped'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'prospect_type'
  ),
  'SELECT 1',
  "ALTER TABLE affiliate_prospects ADD COLUMN prospect_type ENUM('prospective_affiliate','prospective_customer','status_unknown','disqualified') DEFAULT NULL AFTER follower_count"
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND INDEX_NAME = 'idx_ap_prospect_type'
  ),
  'SELECT 1',
  'CREATE INDEX idx_ap_prospect_type ON affiliate_prospects(user_id, prospect_type)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS affiliate_group_assignments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  group_id INT NOT NULL,
  prospect_id INT NOT NULL,
  assigned_account_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (prospect_id) REFERENCES affiliate_prospects(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_account_id) REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
  UNIQUE KEY unique_affiliate_group_prospect (user_id, group_id, prospect_id),
  INDEX idx_aga_user_group_account (user_id, group_id, assigned_account_id),
  INDEX idx_aga_prospect (prospect_id)
);

CREATE TABLE IF NOT EXISTS affiliate_special_notes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  tiktok_username VARCHAR(255) NOT NULL,
  note_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_asn_user_username (user_id, tiktok_username),
  INDEX idx_asn_user_created (user_id, created_at)
);
