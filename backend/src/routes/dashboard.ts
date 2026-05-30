import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';
import jwt from 'jsonwebtoken';
import { subscribe, sendUserEvent } from '../events/broadcaster.js';
import { runTikTokSearchForAccounts } from '../workers/tiktokSearchWorker.js';
import { runTikTokFeedForAccounts } from '../workers/tiktokFeedWorker.js';
import { runAffiliateProcurementForAccounts, setAffiliateRunning } from '../workers/affiliateProcurementWorker.js';

const router = Router();

// Get dashboard statistics
router.get('/stats', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;

    // Get date range (last 30 days)
    const [dailyStats]: any = await db.query(
      `SELECT 
         date,
         SUM(CASE WHEN action_type = 'dm_sent' THEN 1 ELSE 0 END) as dms_sent,
         SUM(CASE WHEN action_type = 'comment_posted' THEN 1 ELSE 0 END) as comments_posted,
         SUM(CASE WHEN action_type = 'dm_reply_received' THEN 1 ELSE 0 END) as dm_replies,
         SUM(CASE WHEN action_type = 'comment_reply_received' THEN 1 ELSE 0 END) as comment_replies,
         SUM(CASE WHEN action_type = 'comment_liked' THEN 1 ELSE 0 END) as comment_likes
       FROM activity_logs
       WHERE user_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY date
       ORDER BY date DESC`,
      [userId]
    );

    // Get total stats
    const [totals]: any = await db.query(
      `SELECT 
         COUNT(CASE WHEN action_type = 'dm_sent' THEN 1 END) as total_dms,
         COUNT(CASE WHEN action_type = 'comment_posted' THEN 1 END) as total_comments,
         COUNT(CASE WHEN action_type = 'dm_reply_received' THEN 1 END) as total_dm_replies,
         COUNT(CASE WHEN action_type = 'comment_reply_received' THEN 1 END) as total_comment_replies,
         COUNT(CASE WHEN action_type = 'comment_liked' THEN 1 END) as total_likes
       FROM activity_logs
       WHERE user_id = ?`,
      [userId]
    );

    // Get automation status
    const [automationState]: any = await db.query(
      'SELECT is_running, last_action_at, error_count FROM automation_state WHERE user_id = ?',
      [userId]
    );

    // Get TikTok accounts
    console.log(`[Dashboard Stats] Fetching accounts for user_id: ${userId}`);
    const [accounts]: any = await db.query(
      `SELECT ta.id, ta.account_identifier, ta.is_active, ta.is_paused, ta.last_used_at, ta.actions_count, ta.session_data,
              ta.group_id, ag.name AS group_name
       FROM tiktok_accounts ta
       LEFT JOIN account_groups ag ON ag.id = ta.group_id
       WHERE ta.user_id = ?`,
      [userId]
    );
    console.log(`[Dashboard Stats] Found ${accounts.length} accounts:`, accounts.map((a: any) => ({ id: a.id, name: a.account_identifier, user_id: userId })));

    res.json({
      dailyStats,
      totals: totals[0] || {},
      automation: automationState[0] || { is_running: false },
      accounts
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get account-specific stats for a date range
router.get('/account-stats/:accountId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const accountId = parseInt(req.params.accountId);
    const startDate = req.query.startDate as string || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = req.query.endDate as string || new Date().toISOString().split('T')[0];

    // Verify the account belongs to this user
    const [accountCheck]: any = await db.query(
      'SELECT id FROM tiktok_accounts WHERE id = ? AND user_id = ?',
      [accountId, userId]
    );

    if (!accountCheck || accountCheck.length === 0) {
      return res.status(403).json({ message: 'Account not found' });
    }

    // Get DMs sent
    const [dmsResult]: any = await db.query(
      `SELECT COUNT(*) as count FROM activity_logs 
       WHERE tiktok_account_id = ? 
         AND action_type = 'dm_sent' 
         AND DATE(created_at) >= ? 
         AND DATE(created_at) <= ?`,
      [accountId, startDate, endDate]
    );

    // Get comment replies posted
    const [commentsResult]: any = await db.query(
      `SELECT COUNT(*) as count FROM activity_logs 
       WHERE tiktok_account_id = ? 
         AND action_type = 'comment_posted' 
         AND DATE(created_at) >= ? 
         AND DATE(created_at) <= ?`,
      [accountId, startDate, endDate]
    );

    res.json({
      accountId,
      startDate,
      endDate,
      dms_sent: (dmsResult[0] as any)?.count || 0,
      comment_replies: (commentsResult[0] as any)?.count || 0
    });
  } catch (error) {
    console.error('Account stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get affiliate account-specific stats for a date range
router.get('/affiliate-account-stats/:accountId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const accountId = parseInt(req.params.accountId);
    const startDate = req.query.startDate as string || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = req.query.endDate as string || new Date().toISOString().split('T')[0];

    const [accountCheck]: any = await db.query(
      'SELECT id FROM tiktok_accounts WHERE id = ? AND user_id = ?',
      [accountId, userId]
    );

    if (!accountCheck || accountCheck.length === 0) {
      return res.status(403).json({ message: 'Account not found' });
    }

    const [pipelineRows]: any = await db.query(
      `SELECT COUNT(*) AS count
       FROM affiliate_prospects
       WHERE user_id = ?
         AND incogniton_account_id = ?
         AND last_interaction_at IS NOT NULL
         AND DATE(last_interaction_at) >= ?
         AND DATE(last_interaction_at) <= ?`,
      [userId, accountId, startDate, endDate]
    );

    const [videoRows]: any = await db.query(
      `SELECT
         SUM(CASE WHEN iv.liked = 1 THEN 1 ELSE 0 END) AS videos_liked,
         SUM(CASE WHEN iv.comment_posted = 1 THEN 1 ELSE 0 END) AS comments_left
       FROM affiliate_interacted_videos iv
       JOIN affiliate_prospects ap
         ON ap.user_id = iv.user_id
        AND ap.tiktok_username = iv.tiktok_username
       WHERE iv.user_id = ?
         AND ap.incogniton_account_id = ?
         AND DATE(iv.interacted_at) >= ?
         AND DATE(iv.interacted_at) <= ?`,
      [userId, accountId, startDate, endDate]
    );

    const [followedRows]: any = await db.query(
      `SELECT COUNT(*) AS count
       FROM affiliate_prospects
       WHERE user_id = ?
         AND incogniton_account_id = ?
         AND is_following = 1
         AND DATE(updated_at) >= ?
         AND DATE(updated_at) <= ?`,
      [userId, accountId, startDate, endDate]
    );

    const [followedUsRows]: any = await db.query(
      `SELECT COUNT(*) AS count
       FROM affiliate_prospects
       WHERE user_id = ?
         AND incogniton_account_id = ?
         AND is_following_us = 1
         AND DATE(updated_at) >= ?
         AND DATE(updated_at) <= ?`,
      [userId, accountId, startDate, endDate]
    );

    const [commentsLikedRows]: any = await db.query(
      `SELECT COUNT(*) AS count
       FROM activity_logs
       WHERE user_id = ?
         AND tiktok_account_id = ?
         AND action_type = 'comment_liked'
         AND DATE(created_at) >= ?
         AND DATE(created_at) <= ?`,
      [userId, accountId, startDate, endDate]
    );

    const [commentRepliesRows]: any = await db.query(
      `SELECT COUNT(*) AS count
       FROM activity_logs
       WHERE user_id = ?
         AND tiktok_account_id = ?
         AND action_type = 'comment_reply_received'
         AND DATE(created_at) >= ?
         AND DATE(created_at) <= ?`,
      [userId, accountId, startDate, endDate]
    );

    res.json({
      accountId,
      startDate,
      endDate,
      prospects_in_pipeline: Number((pipelineRows[0] as any)?.count || 0),
      videos_liked: Number((videoRows[0] as any)?.videos_liked || 0),
      comments_left: Number((videoRows[0] as any)?.comments_left || 0),
      users_followed: Number((followedRows[0] as any)?.count || 0),
      prospects_followed_us: Number((followedUsRows[0] as any)?.count || 0),
      comments_liked: Number((commentsLikedRows[0] as any)?.count || 0),
      replies_to_comments: Number((commentRepliesRows[0] as any)?.count || 0)
    });
  } catch (error) {
    console.error('Affiliate account stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/affiliate/keep-in-touch', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const accountIdRaw = (req.query.accountId as string | undefined)?.trim();

    if (accountIdRaw && accountIdRaw !== 'overall') {
      const accountId = parseInt(accountIdRaw, 10);
      if (!Number.isFinite(accountId)) {
        return res.status(400).json({ message: 'Invalid accountId' });
      }

      const [accountCheck]: any = await db.query(
        'SELECT id FROM tiktok_accounts WHERE id = ? AND user_id = ?',
        [accountId, userId]
      );

      if (!accountCheck || accountCheck.length === 0) {
        return res.status(403).json({ message: 'Account not found' });
      }

      const [rows]: any = await db.query(
        `SELECT id, tiktok_username, profile_url, incogniton_account_id, snoozed_until, updated_at
         FROM affiliate_prospects
         WHERE user_id = ? AND is_keep_in_touch = 1 AND incogniton_account_id = ?
         ORDER BY updated_at DESC`,
        [userId, accountId]
      );

      return res.json({ users: rows || [] });
    }

    const [rows]: any = await db.query(
      `SELECT id, tiktok_username, profile_url, incogniton_account_id, snoozed_until, updated_at
       FROM affiliate_prospects
       WHERE user_id = ? AND is_keep_in_touch = 1
       ORDER BY updated_at DESC`,
      [userId]
    );

    return res.json({ users: rows || [] });
  } catch (error) {
    console.error('Keep in touch list error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/affiliate/keep-in-touch', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const rawUsername = String(req.body?.username || '').trim();

    if (!rawUsername) {
      return res.status(400).json({ message: 'username is required' });
    }

    const username = rawUsername
      .replace(/^https?:\/\/www\.tiktok\.com\/@/i, '')
      .replace(/^https?:\/\/tiktok\.com\/@/i, '')
      .replace(/^@/, '')
      .split('/')[0]
      .trim()
      .toLowerCase();

    if (!/^[a-z0-9._]{2,24}$/i.test(username)) {
      return res.status(400).json({ message: 'Invalid TikTok username format' });
    }

    const [configRows]: any = await db.query(
      'SELECT keep_in_touch_snooze_days FROM user_config WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const keepInTouchSnoozeDays = Number((configRows?.[0] as any)?.keep_in_touch_snooze_days ?? 14);

    const profileUrl = `https://www.tiktok.com/@${username}`;
    const snoozedUntil = new Date(Date.now() + keepInTouchSnoozeDays * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO affiliate_prospects (user_id, tiktok_username, profile_url, is_keep_in_touch, snoozed_until)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         profile_url = VALUES(profile_url),
         is_keep_in_touch = 1,
         snoozed_until = VALUES(snoozed_until),
         dm_sent = 0,
         dm_sent_at = NULL`,
      [userId, username, profileUrl, snoozedUntil]
    );

    return res.json({
      success: true,
      username,
      profile_url: profileUrl,
      keep_in_touch_snooze_days: keepInTouchSnoozeDays
    });
  } catch (error) {
    console.error('Keep in touch add error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/affiliate/keep-in-touch/:prospectId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const prospectId = parseInt(req.params.prospectId, 10);

    if (!Number.isFinite(prospectId)) {
      return res.status(400).json({ message: 'Invalid prospectId' });
    }

    const [rows]: any = await db.query(
      'SELECT id FROM affiliate_prospects WHERE id = ? AND user_id = ? LIMIT 1',
      [prospectId, userId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: 'Prospect not found' });
    }

    await db.query(
      'UPDATE affiliate_prospects SET is_keep_in_touch = 0 WHERE id = ? AND user_id = ?',
      [prospectId, userId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Keep in touch remove error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/affiliate/ignore-list', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;

    const [rows]: any = await db.query(
      `SELECT id, tiktok_username, profile_url, updated_at
       FROM affiliate_prospects
       WHERE user_id = ? AND is_ignore_list = 1
       ORDER BY updated_at DESC`,
      [userId]
    );

    return res.json({ users: rows || [] });
  } catch (error) {
    console.error('Ignore list fetch error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/affiliate/ignore-list', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const rawUsername = String(req.body?.username || '').trim();

    if (!rawUsername) {
      return res.status(400).json({ message: 'username is required' });
    }

    const username = rawUsername
      .replace(/^https?:\/\/www\.tiktok\.com\/@/i, '')
      .replace(/^https?:\/\/tiktok\.com\/@/i, '')
      .replace(/^@/, '')
      .split('/')[0]
      .trim()
      .toLowerCase();

    if (!/^[a-z0-9._]{2,24}$/i.test(username)) {
      return res.status(400).json({ message: 'Invalid TikTok username format' });
    }

    const profileUrl = `https://www.tiktok.com/@${username}`;

    await db.query(
      `INSERT INTO affiliate_prospects (user_id, tiktok_username, profile_url, is_ignore_list, is_keep_in_touch)
       VALUES (?, ?, ?, 1, 0)
       ON DUPLICATE KEY UPDATE
         profile_url = VALUES(profile_url),
         is_ignore_list = 1,
         is_keep_in_touch = 0`,
      [userId, username, profileUrl]
    );

    return res.json({
      success: true,
      username,
      profile_url: profileUrl
    });
  } catch (error) {
    console.error('Ignore list add error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/affiliate/ignore-list/:prospectId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const prospectId = parseInt(req.params.prospectId, 10);

    if (!Number.isFinite(prospectId)) {
      return res.status(400).json({ message: 'Invalid prospectId' });
    }

    const [rows]: any = await db.query(
      'SELECT id FROM affiliate_prospects WHERE id = ? AND user_id = ? LIMIT 1',
      [prospectId, userId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: 'Prospect not found' });
    }

    await db.query(
      'UPDATE affiliate_prospects SET is_ignore_list = 0 WHERE id = ? AND user_id = ?',
      [prospectId, userId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Ignore list remove error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/affiliate/special-notes', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;

    const [rows]: any = await db.query(
      `SELECT id, tiktok_username, note_text, created_at, updated_at
       FROM affiliate_special_notes
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.json({ notes: rows || [] });
  } catch (error) {
    console.error('Special notes list error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/affiliate/special-notes/:username', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const username = String(req.params.username || '').replace(/^@/, '').trim().toLowerCase();

    if (!username) {
      return res.status(400).json({ message: 'Username is required' });
    }

    const [rows]: any = await db.query(
      `SELECT id, tiktok_username, note_text, created_at, updated_at
       FROM affiliate_special_notes
       WHERE user_id = ? AND tiktok_username = ?
       ORDER BY created_at DESC`,
      [userId, username]
    );

    return res.json({ username, notes: rows || [] });
  } catch (error) {
    console.error('Special notes detail error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/affiliate/special-notes', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const rawUsername = String(req.body?.username || '').trim();
    const noteText = String(req.body?.noteText || '').trim();

    if (!rawUsername || !noteText) {
      return res.status(400).json({ message: 'username and noteText are required' });
    }

    const username = rawUsername
      .replace(/^https?:\/\/www\.tiktok\.com\/@/i, '')
      .replace(/^https?:\/\/tiktok\.com\/@/i, '')
      .replace(/^@/, '')
      .split('/')[0]
      .trim()
      .toLowerCase();

    if (!/^[a-z0-9._]{2,24}$/i.test(username)) {
      return res.status(400).json({ message: 'Invalid TikTok username format' });
    }

    const [result]: any = await db.query(
      `INSERT INTO affiliate_special_notes (user_id, tiktok_username, note_text)
       VALUES (?, ?, ?)`,
      [userId, username, noteText]
    );

    return res.json({ success: true, id: result.insertId, username });
  } catch (error) {
    console.error('Special notes create error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/affiliate/special-notes/:noteId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const noteId = Number(req.params.noteId);
    const noteText = String(req.body?.noteText || '').trim();

    if (!Number.isFinite(noteId) || !noteText) {
      return res.status(400).json({ message: 'noteId and noteText are required' });
    }

    const [rows]: any = await db.query(
      'SELECT id FROM affiliate_special_notes WHERE id = ? AND user_id = ? LIMIT 1',
      [noteId, userId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: 'Note not found' });
    }

    await db.query(
      'UPDATE affiliate_special_notes SET note_text = ? WHERE id = ? AND user_id = ?',
      [noteText, noteId, userId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Special notes update error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/affiliate/special-notes/:noteId', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const noteId = Number(req.params.noteId);

    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ message: 'Invalid noteId' });
    }

    await db.query('DELETE FROM affiliate_special_notes WHERE id = ? AND user_id = ?', [noteId, userId]);
    return res.json({ success: true });
  } catch (error) {
    console.error('Special notes delete error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Toggle pause state for a TikTok account
router.post('/accounts/:accountId/toggle-pause', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const accountId = parseInt(req.params.accountId);

    // Verify the account belongs to this user
    const [accountCheck]: any = await db.query(
      'SELECT id, is_paused FROM tiktok_accounts WHERE id = ? AND user_id = ?',
      [accountId, userId]
    );

    if (!accountCheck || accountCheck.length === 0) {
      return res.status(403).json({ message: 'Account not found' });
    }

    const currentPauseState = accountCheck[0].is_paused;
    const newPauseState = !currentPauseState;

    // Toggle the pause state
    await db.query(
      'UPDATE tiktok_accounts SET is_paused = ? WHERE id = ?',
      [newPauseState, accountId]
    );

    res.json({ 
      success: true, 
      is_paused: newPauseState 
    });
  } catch (error) {
    console.error('Toggle pause error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get recent activity
router.get('/activity', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const limit = parseInt(req.query.limit as string) || 50;

    const [activity]: any = await db.query(
      `SELECT 
         al.action_type,
         al.target_user,
         al.post_url,
         al.success,
         al.error_message,
         al.created_at,
         ta.account_identifier
       FROM activity_logs al
       JOIN tiktok_accounts ta ON al.tiktok_account_id = ta.id
       WHERE al.user_id = ?
       ORDER BY al.created_at DESC
       LIMIT ?`,
      [userId, limit]
    );

    res.json({ activity });
  } catch (error) {
    console.error('Activity fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;

// Server-Sent Events for live dashboard feed (accepts token via query for EventSource compatibility)
router.get('/events', async (req, res) => {
  try {
    let token = ''
    const authHeader = req.headers['authorization']
    if (authHeader) token = authHeader.split(' ')[1]
    if (!token && req.query && req.query.token) token = String(req.query.token)
    if (!token) return res.status(401).end()

    let decoded: any
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret') as any
    } catch (err) {
      return res.status(403).end()
    }
    const userId = decoded.userId

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // Send initial comment
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'connected' })}\n\n`)

    const unsub = subscribe(userId, (payload) => {
      const data = JSON.stringify(payload)
      res.write(`data: ${data}\n\n`)
    })

    // heartbeat
    const iv = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 20000)

    req.on('close', () => {
      clearInterval(iv)
      unsub()
      res.end()
    })
  } catch (err) {
    console.error('SSE error', err)
    res.status(500).end()
  }
})

// Start automation (sets automation_state.is_running=true)
router.post('/start', async (req: any, res) => {
  try {
    const token = req.headers['authorization'] ? String(req.headers['authorization']).split(' ')[1] : ''
    if (!token) return res.status(401).json({ message: 'Authentication required' })
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret')
    const userId = decoded.userId

    // Check if user has any Chrome Debug accounts that need verification
    const [accounts]: any = await db.query(
      'SELECT browser_type FROM tiktok_accounts WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    
    const hasChromeDebugAccounts = accounts.some((acc: any) => acc.browser_type === 'chrome_debug');
    
    if (hasChromeDebugAccounts) {
      // Only check Chrome Debug port if user has Chrome Debug accounts
      try {
        const response = await fetch('http://localhost:9222/json/version');
        if (!response.ok) {
          throw new Error('Chrome not accessible');
        }
      } catch (err) {
        console.error('[Dashboard] Chrome not accessible:', err);
        sendUserEvent(userId, { 
          type: 'error', 
          text: '❌ Chrome not running! Please run launch-chrome.bat first.' 
        });
        return res.status(400).json({ 
          message: 'Chrome not running. Please run launch-chrome.bat first.' 
        });
      }
    }

    await db.query('INSERT INTO automation_state (user_id, is_running) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_running = VALUES(is_running)', [userId, true])
    sendUserEvent(userId, { type: 'status', text: '🟢 Starting automation' })
    
    // Run the full workflow: search posts, then scrape comments
    runAutomationWorkflow(userId);
    
    res.json({ message: 'Started' })
  } catch (err) {
    console.error('Start error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Helper function for automation workflow
async function runAutomationWorkflow(userId: number) {
  try {
    // Search for posts AND extract comments in one pass
    await runTikTokSearchForAccounts(userId);
    
    sendUserEvent(userId, { type: 'success', text: '✅ Automation cycle completed!' });
  } catch (err: any) {
    console.error('[Dashboard] Automation workflow failed:', err);
    sendUserEvent(userId, { type: 'error', text: `Failed: ${err.message}` });
  }
}

// Stop automation
router.post('/stop', async (req: any, res) => {
  try {
    const token = req.headers['authorization'] ? String(req.headers['authorization']).split(' ')[1] : ''
    if (!token) return res.status(401).json({ message: 'Authentication required' })
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret')
    const userId = decoded.userId

    await db.query('INSERT INTO automation_state (user_id, is_running) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_running = VALUES(is_running)', [userId, false])
    sendUserEvent(userId, { type: 'status', text: 'Automation stopped' })
    res.json({ message: 'Stopped' })
  } catch (err) {
    console.error('Stop error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Start affiliate procurement
router.post('/affiliate/start', async (req: any, res) => {
  try {
    const token = req.headers['authorization'] ? String(req.headers['authorization']).split(' ')[1] : ''
    if (!token) return res.status(401).json({ message: 'Authentication required' })
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret')
    const userId = decoded.userId

    const [groupRows]: any = await db.query(
      `SELECT g.id, g.name,
              gp.ai_prompt, gp.example_dm, gp.example_comment,
              gp.brand_voice, gp.affiliate_dm_prompt, gp.affiliate_invitation_text
       FROM account_groups g
       LEFT JOIN group_prompt_config gp
         ON gp.user_id = g.user_id AND gp.group_id = g.id
       WHERE g.user_id = ?`,
      [userId]
    );

    const missingGroups = (groupRows || []).filter((g: any) => {
      const required = [
        g.ai_prompt,
        g.example_dm,
        g.example_comment,
        g.brand_voice,
        g.affiliate_dm_prompt,
        g.affiliate_invitation_text
      ];
      return required.some((v: any) => !String(v || '').trim());
    });

    if (missingGroups.length > 0) {
      const names = missingGroups.map((g: any) => g.name).join(', ');
      return res.status(400).json({
        message: `Cannot start affiliate mode. Missing Group prompts for: ${names}. Please complete Group settings first.`
      });
    }

    await setAffiliateRunning(userId, true)
    sendUserEvent(userId, { type: 'status', text: '🤝 Starting Affiliate Procurement...' })

    // Run async — don't await
    runAffiliateProcurementForAccounts(userId)
      .then(() => {
        setAffiliateRunning(userId, false);
        sendUserEvent(userId, { type: 'success', text: '✅ Affiliate Procurement cycle completed!' });
      })
      .catch(err => {
        setAffiliateRunning(userId, false);
        sendUserEvent(userId, { type: 'error', text: `Affiliate failed: ${err.message}` });
      });

    res.json({ message: 'Affiliate Procurement started' })
  } catch (err) {
    console.error('Affiliate start error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Stop affiliate procurement
router.post('/affiliate/stop', async (req: any, res) => {
  try {
    const token = req.headers['authorization'] ? String(req.headers['authorization']).split(' ')[1] : ''
    if (!token) return res.status(401).json({ message: 'Authentication required' })
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret')
    const userId = decoded.userId

    await setAffiliateRunning(userId, false)
    sendUserEvent(userId, { type: 'status', text: '🔴 Affiliate Procurement stopped' })
    res.json({ message: 'Affiliate Procurement stopped' })
  } catch (err) {
    console.error('Affiliate stop error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Scrape comments from recent posts
router.post('/scrape-comments', async (req: any, res) => {
  try {
    const token = req.headers['authorization'] ? String(req.headers['authorization']).split(' ')[1] : ''
    if (!token) return res.status(401).json({ message: 'Authentication required' })
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret')
    const userId = decoded.userId

    sendUserEvent(userId, { type: 'info', text: 'Starting comment scraping...' })
    
    // Run comment scraping in background
    scrapeCommentsForUser(userId).catch(err => {
      console.error('[Dashboard] Comment scraping failed:', err)
      sendUserEvent(userId, { type: 'error', text: 'Failed to scrape comments' })
    })
    
    res.json({ message: 'Comment scraping started' })
  } catch (err) {
    console.error('Scrape comments error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

// Get scraped comments
router.get('/comments', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    
    // Get comments from posts belonging to this user's accounts
    const [comments]: any = await db.query(
      `SELECT 
         c.id,
         c.username,
         c.comment_text,
         c.likes,
         c.posted_at,
         c.scraped_at,
         c.buying_intent,
         c.buying_intent_confidence,
         c.processed,
         p.video_url,
         p.caption as post_caption
       FROM tiktok_comments c
       JOIN tiktok_posts p ON c.post_id = p.id
       JOIN tiktok_accounts a ON p.account_id = a.id
       WHERE a.user_id = ?
       ORDER BY c.scraped_at DESC, c.posted_at DESC
       LIMIT 100`,
      [userId]
    );

    res.json({ comments });
  } catch (error) {
    console.error('Comments fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

