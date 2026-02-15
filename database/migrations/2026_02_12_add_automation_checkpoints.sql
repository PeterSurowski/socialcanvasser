ALTER TABLE automation_state
  ADD COLUMN checkpoint_account_id INT NULL,
  ADD COLUMN checkpoint_keyword_index INT DEFAULT 0,
  ADD COLUMN checkpoint_video_index INT DEFAULT 0,
  ADD COLUMN checkpoint_video_url VARCHAR(500) NULL,
  ADD COLUMN checkpoint_stage VARCHAR(50) NULL,
  ADD COLUMN checkpoint_engagement_index INT DEFAULT 0,
  ADD COLUMN checkpoint_engagement_username VARCHAR(255) NULL;

CREATE INDEX idx_automation_state_checkpoint_account_id
  ON automation_state (checkpoint_account_id);
