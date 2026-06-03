CREATE TABLE IF NOT EXISTS affiliate_group_state (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  group_id INT NOT NULL,
  last_processed_prospect_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (last_processed_prospect_id) REFERENCES affiliate_prospects(id) ON DELETE SET NULL,
  UNIQUE KEY unique_affiliate_group_state (user_id, group_id),
  INDEX idx_ags_user_group (user_id, group_id)
);
