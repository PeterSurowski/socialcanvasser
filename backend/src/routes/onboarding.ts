import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';

const router = Router();

// Complete onboarding
router.post('/complete', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const {
      tiktokAccounts,
      keywords,
      aiPrompt,
      creatorMessage,
      exampleDM,
      exampleComment,
      openaiKey,
      brandVoice,
      snoozeDays,
      keepInTouchSnoozeDays,
      affiliateDmPrompt,
      affiliateInvitationText,
      affiliateDmEdsThreshold,
      minAffiliateFollowers
    } = req.body;

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
      // Save TikTok accounts (skip if already created via /tiktok/connect)
      // Supports legacy shape (string[]) and new shape ({nickname, groupName}[]).
      for (const accountEntry of tiktokAccounts) {
        const accountName = typeof accountEntry === 'string' ? accountEntry : String(accountEntry?.nickname || '').trim();
        const groupNameRaw = typeof accountEntry === 'string' ? '' : String(accountEntry?.groupName || '').trim();
        const groupName = groupNameRaw || 'Default';

        if (!accountName) {
          continue;
        }

        const [groupRows]: any = await connection.query(
          'SELECT id FROM account_groups WHERE user_id = ? AND name = ? LIMIT 1',
          [userId, groupName]
        );

        let groupId: number;
        if (Array.isArray(groupRows) && groupRows.length > 0) {
          groupId = Number(groupRows[0].id);
        } else {
          const [groupInsert]: any = await connection.query(
            'INSERT INTO account_groups (user_id, name) VALUES (?, ?)',
            [userId, groupName]
          );
          groupId = Number(groupInsert.insertId);
        }

        // Check if account already exists
        const [existing] = await connection.query(
          'SELECT id FROM tiktok_accounts WHERE user_id = ? AND account_identifier = ?',
          [userId, accountName]
        );
        
        if (!Array.isArray(existing) || existing.length === 0) {
          // Only create if it doesn't exist
          await connection.query(
            'INSERT INTO tiktok_accounts (user_id, group_id, account_identifier, is_active) VALUES (?, ?, ?, ?)',
            [userId, groupId, accountName, true]
          );
          console.log(`[Onboarding Complete] Created account "${accountName}" for user ${userId}`);
        } else {
          await connection.query(
            'UPDATE tiktok_accounts SET group_id = ? WHERE id = ?',
            [groupId, (existing[0] as any).id]
          );
          console.log(`[Onboarding Complete] Account "${accountName}" already exists for user ${userId}, skipping`);
        }
      }

      // Save configuration
      await connection.query(
        `INSERT INTO user_config 
         (user_id, keywords, ai_prompt, creator_message, example_dm, example_comment, openai_api_key, is_onboarding_complete, brand_voice, snooze_days, keep_in_touch_snooze_days, affiliate_dm_prompt, affiliate_invitation_text, affiliate_dm_eds_threshold, min_affiliate_followers) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
         keywords = VALUES(keywords),
         ai_prompt = VALUES(ai_prompt),
         creator_message = VALUES(creator_message),
         example_dm = VALUES(example_dm),
         example_comment = VALUES(example_comment),
         openai_api_key = VALUES(openai_api_key),
         is_onboarding_complete = VALUES(is_onboarding_complete),
         brand_voice = VALUES(brand_voice),
         snooze_days = VALUES(snooze_days),
         keep_in_touch_snooze_days = VALUES(keep_in_touch_snooze_days),
         affiliate_dm_prompt = VALUES(affiliate_dm_prompt),
         affiliate_invitation_text = VALUES(affiliate_invitation_text),
         affiliate_dm_eds_threshold = VALUES(affiliate_dm_eds_threshold),
         min_affiliate_followers = VALUES(min_affiliate_followers)`,
        [userId, keywords, aiPrompt, creatorMessage || null, exampleDM, exampleComment, openaiKey, true, brandVoice || null, snoozeDays || 3, keepInTouchSnoozeDays || 14, affiliateDmPrompt || null, affiliateInvitationText || null, affiliateDmEdsThreshold || 4, minAffiliateFollowers || 2000]
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

// Create a TikTok account record (supports both Chrome Debug and Incogniton)
router.post('/tiktok/connect', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { nickname, groupName, browserType, incognitonProfileId } = req.body;
    
    if (!nickname) return res.status(400).json({ message: 'Nickname required' });
    if (!groupName || !String(groupName).trim()) return res.status(400).json({ message: 'Group is required' });
    
    // Validate Incogniton requirements
    if (browserType === 'incogniton' && !incognitonProfileId) {
      return res.status(400).json({ message: 'Incogniton Profile ID required' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
      const normalizedGroupName = String(groupName).trim();

      const [groupRows]: any = await connection.query(
        'SELECT id FROM account_groups WHERE user_id = ? AND name = ? LIMIT 1',
        [userId, normalizedGroupName]
      );

      let groupId: number;
      if (Array.isArray(groupRows) && groupRows.length > 0) {
        groupId = Number(groupRows[0].id);
      } else {
        const [groupInsert]: any = await connection.query(
          'INSERT INTO account_groups (user_id, name) VALUES (?, ?)',
          [userId, normalizedGroupName]
        );
        groupId = Number(groupInsert.insertId);
      }

      // Check if account with this nickname already exists for this user (prevent duplicates)
      const [existing] = await connection.query(
        'SELECT id FROM tiktok_accounts WHERE user_id = ? AND account_identifier = ?',
        [userId, nickname]
      );
      
      if (Array.isArray(existing) && existing.length > 0) {
        await connection.commit();
        connection.release();
        console.log(`[Onboarding] Account "${nickname}" already exists for user ${userId}, returning existing ID`);
        // Return existing account instead of creating duplicate
        const isActive = browserType === 'incogniton';
        await connection.query('UPDATE tiktok_accounts SET group_id = ? WHERE id = ?', [groupId, (existing[0] as any).id]);
        return res.json({ 
          message: 'Account already exists', 
          accountId: (existing[0] as any).id,
          groupId,
          groupName: normalizedGroupName,
          browserType: browserType || 'chrome_debug',
          isActive,
          launchCommand: browserType === 'incogniton' ? null : 'launch-chrome.bat'
        });
      }
      
      // For Incogniton accounts, mark as active immediately (no verification needed)
      const isActive = browserType === 'incogniton';
      const sessionData = browserType === 'incogniton' 
        ? { type: 'incogniton', profileId: incognitonProfileId, ready: true }
        : { type: 'local-chrome', ready: false };
      
      const [result] = await connection.query(
        'INSERT INTO tiktok_accounts (user_id, group_id, account_identifier, browser_type, incogniton_profile_id, is_active, session_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, groupId, nickname, browserType || 'chrome_debug', incognitonProfileId || null, isActive, JSON.stringify(sessionData)]
      );

      await connection.commit();
      connection.release();

      const accountId = (result as any).insertId;
      console.log(`[Onboarding] Created new ${browserType || 'chrome_debug'} account "${nickname}" (ID: ${accountId}) for user ${userId}`);
      
      return res.json({ 
        message: 'Account created', 
        accountId,
        groupId,
        groupName: normalizedGroupName,
        browserType: browserType || 'chrome_debug',
        isActive,
        launchCommand: browserType === 'incogniton' ? null : 'launch-chrome.bat'
      });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('tiktok connect error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Mark account as ready after user has launched Chrome and logged in
router.post('/tiktok/complete', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ message: 'accountId required' });

    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // Verify account belongs to user
      const [rows] = await connection.query(
        'SELECT id FROM tiktok_accounts WHERE id = ? AND user_id = ?',
        [accountId, userId]
      );
      
      if (!Array.isArray(rows) || rows.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ message: 'Account not found' });
      }

      // Verify Chrome debug port is accessible and capture cookies
      let capturedCookies: any[] = [];
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const probe = await fetch('http://127.0.0.1:9222/json/version', { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!probe.ok) {
          await connection.rollback();
          connection.release();
          return res.status(400).json({ message: 'Chrome debug port not accessible. Please launch Chrome using launch-chrome.bat' });
        }

        // Now capture cookies from TikTok page
        const puppeteer = await import('puppeteer-core');
        const browser = await puppeteer.default.connect({
          browserURL: 'http://127.0.0.1:9222'
        });

        // Get all pages and find TikTok
        const pages = await browser.pages();
        const tiktokPage = pages.find(p => p.url().includes('tiktok.com'));
        
        if (tiktokPage) {
          // Capture all cookies from TikTok domain
          capturedCookies = await tiktokPage.cookies();
          console.log(`[Onboarding] Captured ${capturedCookies.length} cookies from TikTok for account ${accountId}`);
        } else {
          console.warn(`[Onboarding] No TikTok page found for account ${accountId}, cannot capture cookies`);
        }

        await browser.disconnect();
      } catch (err) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ message: 'Chrome not running in debug mode. Please launch Chrome using launch-chrome.bat' });
      }

      // Mark account as ready with captured cookies
      const sessionData = {
        type: 'local-chrome',
        ready: true,
        cookies: capturedCookies
      };
      
      await connection.query(
        'UPDATE tiktok_accounts SET session_data = ?, is_active = ?, last_checked = NOW() WHERE id = ?',
        [JSON.stringify(sessionData), true, accountId]
      );

      await connection.commit();
      connection.release();

      return res.json({ message: 'Account ready', accountId });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('tiktok complete error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
