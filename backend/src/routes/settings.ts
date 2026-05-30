import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';

const router = Router();

// Get current settings
router.get('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;

    const [config]: any = await db.query(
      'SELECT keywords, ai_prompt, creator_message, example_dm, example_comment, openai_api_key, brand_voice, snooze_days, keep_in_touch_snooze_days, affiliate_dm_prompt, affiliate_invitation_text, affiliate_dm_eds_threshold, min_affiliate_followers FROM user_config WHERE user_id = ?',
      [userId]
    );

    // Get actions_per_session from first TikTok account (all accounts should have same value)
    const [accountConfig]: any = await db.query(
      'SELECT actions_per_session FROM tiktok_accounts WHERE user_id = ? LIMIT 1',
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
      config: {
        ...(config[0] || {}),
        actions_per_session: accountConfig[0]?.actions_per_session || 20
      },
      accounts,
      automationEnabled: automation[0]?.automation_enabled || false
    });
  } catch (error) {
    console.error('Settings fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/groups', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;

    const [groups]: any = await db.query(
      `SELECT g.id, g.name,
              gp.ai_prompt, gp.example_dm, gp.example_comment,
              gp.brand_voice, gp.affiliate_dm_prompt, gp.affiliate_invitation_text
       FROM account_groups g
       LEFT JOIN group_prompt_config gp
         ON gp.user_id = g.user_id AND gp.group_id = g.id
       WHERE g.user_id = ?
       ORDER BY g.name ASC`,
      [userId]
    );

    return res.json({ groups: groups || [] });
  } catch (error) {
    console.error('Settings groups fetch error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/groups/:groupId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const groupId = Number(req.params.groupId);

    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ message: 'Invalid groupId' });
    }

    const [groupRows]: any = await db.query(
      'SELECT id FROM account_groups WHERE id = ? AND user_id = ? LIMIT 1',
      [groupId, userId]
    );

    if (!groupRows || groupRows.length === 0) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const {
      aiPrompt,
      exampleDM,
      exampleComment,
      brandVoice,
      affiliateDmPrompt,
      affiliateInvitationText
    } = req.body || {};

    await db.query(
      `INSERT INTO group_prompt_config
         (user_id, group_id, ai_prompt, example_dm, example_comment, brand_voice, affiliate_dm_prompt, affiliate_invitation_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         ai_prompt = VALUES(ai_prompt),
         example_dm = VALUES(example_dm),
         example_comment = VALUES(example_comment),
         brand_voice = VALUES(brand_voice),
         affiliate_dm_prompt = VALUES(affiliate_dm_prompt),
         affiliate_invitation_text = VALUES(affiliate_invitation_text)`,
      [
        userId,
        groupId,
        aiPrompt ?? null,
        exampleDM ?? null,
        exampleComment ?? null,
        brandVoice ?? null,
        affiliateDmPrompt ?? null,
        affiliateInvitationText ?? null
      ]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Settings group update error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update settings
router.put('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const {
      keywords,
      aiPrompt,
      creatorMessage,
      exampleDM,
      exampleComment,
      openaiApiKey,
      actionsPerSession,
      brandVoice,
      snoozeDays,
      keepInTouchSnoozeDays,
      affiliateDmPrompt,
      affiliateInvitationText,
      affiliateDmEdsThreshold,
      minAffiliateFollowers
    } = req.body;

    await db.query(
      `UPDATE user_config 
       SET keywords = ?, ai_prompt = ?, creator_message = ?, example_dm = ?, example_comment = ?, openai_api_key = ?,
           brand_voice = ?, snooze_days = ?, keep_in_touch_snooze_days = ?, affiliate_dm_prompt = ?, affiliate_invitation_text = ?, affiliate_dm_eds_threshold = ?, min_affiliate_followers = ?
       WHERE user_id = ?`,
      [keywords, aiPrompt, creatorMessage, exampleDM, exampleComment, openaiApiKey, brandVoice ?? null, snoozeDays ?? 3, keepInTouchSnoozeDays ?? 14, affiliateDmPrompt ?? null, affiliateInvitationText ?? null, affiliateDmEdsThreshold ?? 4, minAffiliateFollowers ?? 2000, userId]
    );

    // Update actions_per_session for all user's TikTok accounts
    if (actionsPerSession !== undefined) {
      await db.query(
        'UPDATE tiktok_accounts SET actions_per_session = ? WHERE user_id = ?',
        [actionsPerSession, userId]
      );
    }

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
