-- Add affiliate_dm_prompt column to user_config
SET @sql = IF(
  NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'user_config'
      AND COLUMN_NAME  = 'affiliate_dm_prompt'
  ),
  'ALTER TABLE user_config ADD COLUMN affiliate_dm_prompt TEXT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
