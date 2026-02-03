-- Add columns for multi-account rotation and rate limit tracking
ALTER TABLE tiktok_accounts 
ADD COLUMN actions_per_session INT NOT NULL DEFAULT 2,
ADD COLUMN current_session_actions INT NOT NULL DEFAULT 0,
ADD COLUMN is_rate_limited BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN rate_limit_detected_at TIMESTAMP NULL,
ADD COLUMN rate_limit_expires_at TIMESTAMP NULL;

-- Index for finding active (non-rate-limited) accounts
CREATE INDEX idx_tiktok_accounts_rate_limited ON tiktok_accounts(is_rate_limited, rate_limit_expires_at);

-- Index for finding accounts by user
CREATE INDEX idx_tiktok_accounts_user_id ON tiktok_accounts(user_id);
