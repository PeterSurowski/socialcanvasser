-- Relationship-depth affiliate model
-- Adds prospect state, scraped context storage, and EDS DM threshold config.

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_config' AND COLUMN_NAME = 'affiliate_dm_eds_threshold'
  ),
  'SELECT 1',
  'ALTER TABLE user_config ADD COLUMN affiliate_dm_eds_threshold INT DEFAULT 4'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'engagement_depth_score'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN engagement_depth_score INT DEFAULT 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'interaction_sessions'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN interaction_sessions INT DEFAULT 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'bio_scraped'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN bio_scraped BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'bio_text'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN bio_text TEXT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'user_title'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN user_title VARCHAR(255) NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'is_following'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN is_following BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'is_following_us'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN is_following_us BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_prospects' AND COLUMN_NAME = 'last_interaction_at'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_prospects ADD COLUMN last_interaction_at TIMESTAMP NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_interacted_videos' AND COLUMN_NAME = 'caption'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_interacted_videos ADD COLUMN caption TEXT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_interacted_videos' AND COLUMN_NAME = 'comments_json'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_interacted_videos ADD COLUMN comments_json LONGTEXT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_interacted_videos' AND COLUMN_NAME = 'liked'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_interacted_videos ADD COLUMN liked BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliate_interacted_videos' AND COLUMN_NAME = 'comment_posted'
  ),
  'SELECT 1',
  'ALTER TABLE affiliate_interacted_videos ADD COLUMN comment_posted BOOLEAN DEFAULT FALSE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
