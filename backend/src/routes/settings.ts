import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';

const router = Router();

// Get current settings
router.get('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;

    const [config]: any = await db.query(
      'SELECT keywords, ai_prompt, example_dm, example_comment, openai_api_key FROM user_config WHERE user_id = ?',
      [userId]
    );

    const [accounts]: any = await db.query(
      'SELECT id, account_identifier, is_active FROM tiktok_accounts WHERE user_id = ?',
      [userId]
    );

    const [automation]: any = await db.query(
      'SELECT automation_enabled FROM user_config WHERE user_id = ?',
      [userId]
    );

    res.json({
      config: config[0] || {},
      accounts,
      automationEnabled: automation[0]?.automation_enabled || false
    });
  } catch (error) {
    console.error('Settings fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update settings
router.put('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { keywords, aiPrompt, exampleDM, exampleComment, openaiApiKey } = req.body;

    await db.query(
      `UPDATE user_config 
       SET keywords = ?, ai_prompt = ?, example_dm = ?, example_comment = ?, openai_api_key = ?
       WHERE user_id = ?`,
      [keywords, aiPrompt, exampleDM, exampleComment, openaiApiKey, userId]
    );

    res.json({ message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Toggle automation
router.post('/automation/toggle', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { enabled } = req.body;

    await db.query(
      'UPDATE user_config SET automation_enabled = ? WHERE user_id = ?',
      [enabled, userId]
    );

    await db.query(
      'UPDATE automation_state SET is_running = ? WHERE user_id = ?',
      [enabled, userId]
    );

    res.json({ message: `Automation ${enabled ? 'enabled' : 'disabled'}` });
  } catch (error) {
    console.error('Toggle automation error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
