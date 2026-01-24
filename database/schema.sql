-- Social Canvasser Database Schema

CREATE DATABASE IF NOT EXISTS socialcanvasser;
USE socialcanvasser;

-- Users table (app login credentials)
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_username (username),
    INDEX idx_email (email)
);

-- TikTok accounts table
CREATE TABLE tiktok_accounts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    account_identifier VARCHAR(255) NOT NULL,
    session_data TEXT, -- Encrypted cookies/session info (JSON blob)
    session_expires_at TIMESTAMP NULL,
    last_checked TIMESTAMP NULL,
    in_use BOOLEAN DEFAULT FALSE,
    cooldown_until TIMESTAMP NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP NULL,
    actions_count INT DEFAULT 0, -- Track actions for rotation
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id)
);

-- Configuration table
CREATE TABLE user_config (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT UNIQUE NOT NULL,
    keywords TEXT NOT NULL, -- Comma-separated keywords
    ai_prompt TEXT NOT NULL, -- Prompt for OpenAI
    example_dm TEXT NOT NULL,
    example_comment TEXT NOT NULL,
    openai_api_key VARCHAR(255) NOT NULL,
    is_onboarding_complete BOOLEAN DEFAULT FALSE,
    automation_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Activity logs table
CREATE TABLE activity_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    tiktok_account_id INT NOT NULL,
    action_type ENUM('dm_sent', 'comment_posted', 'dm_reply_received', 'comment_reply_received', 'comment_liked') NOT NULL,
    target_user VARCHAR(255), -- TikTok username we contacted
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
CREATE TABLE contacted_users (
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

-- Job queue state (optional, for tracking automation state)
CREATE TABLE automation_state (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT UNIQUE NOT NULL,
    is_running BOOLEAN DEFAULT FALSE,
    current_tiktok_account_id INT,
    last_keyword_index INT DEFAULT 0,
    actions_this_session INT DEFAULT 0,
    last_action_at TIMESTAMP NULL,
    error_count INT DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (current_tiktok_account_id) REFERENCES tiktok_accounts(id) ON DELETE SET NULL
);
