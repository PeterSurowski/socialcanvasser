-- TikTok posts found via keyword search
CREATE TABLE IF NOT EXISTS tiktok_posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  username VARCHAR(255) NOT NULL,
  caption TEXT,
  video_url VARCHAR(500) NOT NULL UNIQUE,
  likes INT DEFAULT 0,
  comments INT DEFAULT 0,
  shares INT DEFAULT 0,
  found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
  INDEX idx_account_processed (account_id, processed),
  INDEX idx_found_at (found_at)
);
