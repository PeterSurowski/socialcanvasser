-- Add is_paused column to tiktok_accounts table
ALTER TABLE tiktok_accounts 
ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT FALSE AFTER is_rate_limited;

-- Add index for paused accounts
CREATE INDEX idx_tiktok_accounts_paused ON tiktok_accounts(is_paused);
