-- Migration: Add Incogniton profile support to tiktok_accounts table
-- This allows storing Incogniton profile IDs for automatic account switching

ALTER TABLE tiktok_accounts 
ADD COLUMN incogniton_profile_id VARCHAR(255) DEFAULT NULL 
AFTER session_data,
ADD COLUMN browser_type ENUM('chrome_debug', 'incogniton') DEFAULT 'chrome_debug' 
AFTER incogniton_profile_id;

-- Add index for faster lookups by profile ID
CREATE INDEX idx_incogniton_profile_id ON tiktok_accounts(incogniton_profile_id);

-- Add comment to document the fields
ALTER TABLE tiktok_accounts 
MODIFY COLUMN incogniton_profile_id VARCHAR(255) DEFAULT NULL 
COMMENT 'Incogniton browser profile ID for persistent session management',
MODIFY COLUMN browser_type ENUM('chrome_debug', 'incogniton') DEFAULT 'chrome_debug' 
COMMENT 'Browser connection method: chrome_debug (legacy) or incogniton (recommended)';
