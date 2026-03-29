-- Add creator_message column to user_config table
ALTER TABLE user_config ADD COLUMN creator_message TEXT DEFAULT NULL AFTER ai_prompt;
