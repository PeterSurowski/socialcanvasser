-- Affiliate Procurement Tables & Columns Migration
-- Run this after the base schema

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

-- New config columns for affiliate procurement
ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS brand_voice TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS snooze_days INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS affiliate_invitation_text TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS affiliate_automation_enabled BOOLEAN DEFAULT FALSE;

-- New state columns for affiliate automation tracking
ALTER TABLE automation_state
  ADD COLUMN IF NOT EXISTS affiliate_is_running BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS affiliate_keyword_index INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS affiliate_users_processed INT DEFAULT 0;
