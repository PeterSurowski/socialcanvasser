-- Ignore List support for affiliate prospects.
-- Marks prospects to skip all automation across Incogniton profiles.

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'is_ignore_list'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN is_ignore_list BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND INDEX_NAME = 'idx_ap_ignore_list'
  ),
  'SELECT 1',
  'CREATE INDEX idx_ap_ignore_list ON affiliate_prospects(user_id, is_ignore_list)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
