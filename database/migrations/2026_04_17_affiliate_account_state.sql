-- Migration: persist affiliate account rotation state
-- Adds affiliate_last_account_id to automation_state so the worker can resume
-- from the correct Incogniton profile when restarted.

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'automation_state'
      AND COLUMN_NAME  = 'affiliate_last_account_id'
  ),
  'SELECT 1',
  'ALTER TABLE automation_state ADD COLUMN affiliate_last_account_id INT NULL DEFAULT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
