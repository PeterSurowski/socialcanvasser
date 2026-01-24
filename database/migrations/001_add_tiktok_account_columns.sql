-- Migration: add session metadata columns to tiktok_accounts
ALTER TABLE tiktok_accounts
  ADD COLUMN session_expires_at TIMESTAMP NULL,
  ADD COLUMN last_checked TIMESTAMP NULL,
  ADD COLUMN in_use BOOLEAN DEFAULT FALSE,
  ADD COLUMN cooldown_until TIMESTAMP NULL;

-- Note: run this against your `socialcanvasser` database.
