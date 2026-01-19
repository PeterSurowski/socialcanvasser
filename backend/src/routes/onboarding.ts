import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';

const router = Router();

// Complete onboarding
router.post('/complete', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { tiktokAccounts, keywords, aiPrompt, exampleDM, exampleComment, openaiKey } = req.body;

    // Validation
    if (!keywords || !aiPrompt || !exampleDM || !exampleComment || !openaiKey) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    if (!Array.isArray(tiktokAccounts) || tiktokAccounts.length === 0) {
      return res.status(400).json({ message: 'At least one TikTok account is required' });
    }

    // Start transaction
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Save TikTok accounts
      for (const accountName of tiktokAccounts) {
        await connection.query(
          'INSERT INTO tiktok_accounts (user_id, account_identifier, is_active) VALUES (?, ?, ?)',
          [userId, accountName, true]
        );
      }

      // Save configuration
      await connection.query(
        `INSERT INTO user_config 
         (user_id, keywords, ai_prompt, example_dm, example_comment, openai_api_key, is_onboarding_complete) 
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
         keywords = VALUES(keywords),
         ai_prompt = VALUES(ai_prompt),
         example_dm = VALUES(example_dm),
         example_comment = VALUES(example_comment),
         openai_api_key = VALUES(openai_api_key),
         is_onboarding_complete = VALUES(is_onboarding_complete)`,
        [userId, keywords, aiPrompt, exampleDM, exampleComment, openaiKey, true]
      );

      // Initialize automation state
      await connection.query(
        `INSERT INTO automation_state (user_id, is_running) 
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE is_running = VALUES(is_running)`,
        [userId, true]
      );

      await connection.commit();
      connection.release();

      res.json({ message: 'Onboarding completed successfully' });
    } catch (error) {
      await connection.rollback();
      connection.release();
      throw error;
    }
  } catch (error) {
    console.error('Onboarding error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
