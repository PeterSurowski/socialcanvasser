-- Add columns to track keyword rotation and search timing
ALTER TABLE tiktok_accounts 
ADD COLUMN last_keyword_index INT DEFAULT 0,
ADD COLUMN last_search_at DATETIME NULL;
