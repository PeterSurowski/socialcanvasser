-- Add TikTok comments table for storing comments from posts
-- Run this to add the comments table to your existing database

USE socialcanvasser;

CREATE TABLE IF NOT EXISTS tiktok_comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id INT NOT NULL,
    comment_id VARCHAR(255), -- TikTok's unique comment ID if available
    username VARCHAR(255) NOT NULL,
    comment_text TEXT NOT NULL,
    likes INT DEFAULT 0,
    posted_at TIMESTAMP NULL, -- When the comment was posted on TikTok
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- When we scraped it
    buying_intent ENUM('pending', 'yes', 'no') DEFAULT 'pending',
    buying_intent_confidence DECIMAL(3,2) NULL, -- 0.00 to 1.00
    processed BOOLEAN DEFAULT FALSE, -- Have we DM'd/replied to this user?
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES tiktok_posts(id) ON DELETE CASCADE,
    INDEX idx_post_id (post_id),
    INDEX idx_username (username),
    INDEX idx_posted_at (posted_at),
    INDEX idx_buying_intent (buying_intent),
    INDEX idx_processed (processed)
);

-- Also need to make sure tiktok_posts table exists with proper structure
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
    processed BOOLEAN DEFAULT FALSE, -- Have we scraped comments for this post?
    scraped_comments_at TIMESTAMP NULL, -- When we last scraped comments
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
    INDEX idx_account_id (account_id),
    INDEX idx_video_url (video_url),
    INDEX idx_processed (processed),
    INDEX idx_found_at (found_at)
);
