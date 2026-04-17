-- Production-safe affiliate procurement schema migration
-- Idempotent: safe to run on environments where some objects already exist.

CREATE TABLE IF NOT EXISTS affiliate_prospects (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  tiktok_username VARCHAR(255) NOT NULL,
  profile_url VARCHAR(500) NOT NULL,
  incogniton_account_id INT NULL,
  snoozed_until TIMESTAMP NULL,
  dm_sent BOOLEAN DEFAULT FALSE,
  dm_sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (incogniton_account_id) REFERENCES tiktok_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY unique_prospect (user_id, tiktok_username),
  INDEX idx_ap_user_id (user_id),
  INDEX idx_ap_snoozed_until (snoozed_until),
  INDEX idx_ap_dm_sent (dm_sent)
);

CREATE TABLE IF NOT EXISTS affiliate_interacted_videos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  video_url VARCHAR(500) NOT NULL,
  tiktok_username VARCHAR(255) NOT NULL,
  interacted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_affiliate_video (user_id, video_url),
  INDEX idx_aiv_user_id (user_id),
  INDEX idx_aiv_username (tiktok_username)
);

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'brand_voice'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN brand_voice TEXT DEFAULT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'snooze_days'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN snooze_days INT DEFAULT 3'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'affiliate_invitation_text'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN affiliate_invitation_text TEXT DEFAULT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'affiliate_automation_enabled'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN affiliate_automation_enabled BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automation_state' AND COLUMN_NAME = 'affiliate_is_running'
  ),
  'SELECT 1',
  'ALTER TABLE automation_state ADD COLUMN affiliate_is_running BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automation_state' AND COLUMN_NAME = 'affiliate_keyword_index'
  ),
  'SELECT 1',
  'ALTER TABLE automation_state ADD COLUMN affiliate_keyword_index INT DEFAULT 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automation_state' AND COLUMN_NAME = 'affiliate_users_processed'
  ),
  'SELECT 1',
  'ALTER TABLE automation_state ADD COLUMN affiliate_users_processed INT DEFAULT 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE activity_logs
  MODIFY COLUMN action_type ENUM(
    'dm_sent',
    'comment_posted',
    'dm_reply_received',
    'comment_reply_received',
    'comment_liked',
    'affiliate_dm_sent',
    'affiliate_comment_posted'
  ) NOT NULL;