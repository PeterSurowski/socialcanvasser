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
      // Save TikTok accounts (skip if already created via /tiktok/connect)
      for (const accountName of tiktokAccounts) {
        // Check if account already exists
        const [existing] = await connection.query(
          'SELECT id FROM tiktok_accounts WHERE user_id = ? AND account_identifier = ?',
          [userId, accountName]
        );
        
        if (!Array.isArray(existing) || existing.length === 0) {
          // Only create if it doesn't exist
          await connection.query(
            'INSERT INTO tiktok_accounts (user_id, account_identifier, is_active) VALUES (?, ?, ?)',
            [userId, accountName, true]
          );
          console.log(`[Onboarding Complete] Created account "${accountName}" for user ${userId}`);
        } else {
          console.log(`[Onboarding Complete] Account "${accountName}" already exists for user ${userId}, skipping`);
        }
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

// Create a TikTok account record (user will launch Chrome manually)
router.post('/tiktok/connect', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { nickname } = req.body;
    if (!nickname) return res.status(400).json({ message: 'Nickname required' });

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
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
        return res.json({ 
          message: 'Account already exists', 
          accountId: (existing[0] as any).id,
          launchCommand: 'launch-chrome.bat'
        });
      }
      
      const [result] = await connection.query(
        'INSERT INTO tiktok_accounts (user_id, account_identifier, is_active, session_data) VALUES (?, ?, ?, ?)',
        [userId, nickname, false, JSON.stringify({ type: 'local-chrome', ready: false })]
      );

      await connection.commit();
      connection.release();

      const accountId = (result as any).insertId;
      console.log(`[Onboarding] Created new account "${nickname}" (ID: ${accountId}) for user ${userId}`);
      return res.json({ 
        message: 'Account created', 
        accountId,
        launchCommand: 'launch-chrome.bat' // User will run this
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
