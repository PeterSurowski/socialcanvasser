-- Keep in Touch mode for affiliate prospects
-- Adds dedicated snooze setting and prospect status flag.

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'keep_in_touch_snooze_days'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN keep_in_touch_snooze_days INT DEFAULT 14'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'is_keep_in_touch'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN is_keep_in_touch BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND INDEX_NAME = 'idx_ap_keep_in_touch'
  ),
  'SELECT 1',
  'CREATE INDEX idx_ap_keep_in_touch ON affiliate_prospects(user_id, is_keep_in_touch, incogniton_account_id)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
