-- Social Canvasser Database Schema - COMPLETE VERSION
-- Includes all migrations and updates

CREATE DATABASE IF NOT EXISTS socialcanvasser;
USE socialcanvasser;

-- Users table (app login credentials)
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_username (username),
    INDEX idx_email (email)
);

-- TikTok accounts table (with ALL migrations applied)
CREATE TABLE IF NOT EXISTS tiktok_accounts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    account_identifier VARCHAR(255) NOT NULL,
    session_data TEXT,
    incogniton_profile_id VARCHAR(255) DEFAULT NULL COMMENT 'Incogniton browser profile ID for persistent session management',
    browser_type ENUM('chrome_debug', 'incogniton') DEFAULT 'chrome_debug' COMMENT 'Browser connection method: chrome_debug (legacy) or incogniton (recommended)',
    session_expires_at TIMESTAMP NULL,
    last_checked TIMESTAMP NULL,
    in_use BOOLEAN DEFAULT FALSE,
    cooldown_until TIMESTAMP NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP NULL,
    actions_count INT DEFAULT 0,
    actions_per_session INT NOT NULL DEFAULT 2,
    current_session_actions INT NOT NULL DEFAULT 0,
    is_rate_limited BOOLEAN NOT NULL DEFAULT FALSE,
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    rate_limit_detected_at TIMESTAMP NULL,
    rate_limit_expires_at TIMESTAMP NULL,
    last_keyword_index INT DEFAULT 0,
    last_search_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_incogniton_profile_id (incogniton_profile_id),
    INDEX idx_tiktok_accounts_rate_limited (is_rate_limited, rate_limit_expires_at),
    INDEX idx_tiktok_accounts_paused (is_paused),
    INDEX idx_tiktok_accounts_user_id (user_id)
);

-- Configuration table
CREATE TABLE IF NOT EXISTS user_config (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT UNIQUE NOT NULL,
    keywords TEXT NOT NULL,
    ai_prompt TEXT NOT NULL,
    creator_message TEXT DEFAULT NULL,
    example_dm TEXT NOT NULL,
    example_comment TEXT NOT NULL,
    openai_api_key VARCHAR(255) NOT NULL,
    brand_voice TEXT DEFAULT NULL,
    snooze_days INT DEFAULT 3,
    affiliate_invitation_text TEXT DEFAULT NULL,
    affiliate_automation_enabled BOOLEAN DEFAULT FALSE,
    is_onboarding_complete BOOLEAN DEFAULT FALSE,
    automation_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- TikTok posts table
CREATE TABLE IF NOT EXISTS tiktok_posts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    account_id INT NOT NULL,
    username VARCHAR(255) NOT NULL,
    caption TEXT,
    video_url VARCHAR(500) NOT NULL UNIQUE,
    likes INT DEFAULT 0,
    comments INT DEFAULT 0,
    shares INT DEFAULT 0,
    found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed BOOLEAN DEFAULT FALSE,
    scraped_comments_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
    INDEX idx_account_id (account_id),
    INDEX idx_video_url (video_url),
    INDEX idx_processed (processed),
    INDEX idx_found_at (found_at),
    INDEX idx_account_processed (account_id, processed)
);

-- TikTok comments table
CREATE TABLE IF NOT EXISTS tiktok_comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id INT NOT NULL,
    comment_id VARCHAR(255),
    username VARCHAR(255) NOT NULL,
    comment_text TEXT NOT NULL,
    likes INT DEFAULT 0,
    posted_at TIMESTAMP NULL,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    buying_intent ENUM('pending', 'yes', 'no') DEFAULT 'pending',
    buying_intent_confidence DECIMAL(3,2) NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES tiktok_posts(id) ON DELETE CASCADE,
    INDEX idx_post_id (post_id),
    INDEX idx_username (username),
    INDEX idx_posted_at (posted_at),
    INDEX idx_buying_intent (buying_intent),
    INDEX idx_processed (processed)
);

-- Activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    tiktok_account_id INT NOT NULL,
    action_type ENUM('dm_sent', 'comment_posted', 'dm_reply_received', 'comment_reply_received', 'comment_liked', 'affiliate_dm_sent', 'affiliate_comment_posted') NOT NULL,
    target_user VARCHAR(255),
    post_url VARCHAR(500),
    message_content TEXT,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date DATE GENERATED ALWAYS AS (DATE(created_at)) STORED,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tiktok_account_id) REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
    INDEX idx_user_date (user_id, date),
    INDEX idx_action_type (action_type),
    INDEX idx_created_at (created_at)
);

-- Contacted users table (prevent duplicate contacts)
CREATE TABLE IF NOT EXISTS contacted_users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    tiktok_username VARCHAR(255) NOT NULL,
    contacted_via ENUM('dm', 'comment') NOT NULL,
    tiktok_account_id INT NOT NULL,
    post_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tiktok_account_id) REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
    UNIQUE KEY unique_contact (user_id, tiktok_username),
    INDEX idx_user_username (user_id, tiktok_username)
);

-- Automation state table (tracking automation state)
CREATE TABLE IF NOT EXISTS automation_state (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT UNIQUE NOT NULL,
    is_running BOOLEAN DEFAULT FALSE,
    affiliate_is_running BOOLEAN DEFAULT FALSE,
    affiliate_keyword_index INT DEFAULT 0,
    affiliate_users_processed INT DEFAULT 0,
    current_tiktok_account_id INT,
    last_keyword_index INT DEFAULT 0,
    actions_this_session INT DEFAULT 0,
    checkpoint_account_id INT NULL,
    checkpoint_keyword_index INT DEFAULT 0,
    checkpoint_video_index INT DEFAULT 0,
    checkpoint_video_url VARCHAR(500) NULL,
    checkpoint_stage VARCHAR(50) NULL,
    checkpoint_engagement_index INT DEFAULT 0,
    checkpoint_engagement_username VARCHAR(255) NULL,
    last_action_at TIMESTAMP NULL,
    error_count INT DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (current_tiktok_account_id) REFERENCES tiktok_accounts(id) ON DELETE SET NULL
);

-- Affiliate procurement tables
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
