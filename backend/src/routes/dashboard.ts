import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';
import jwt from 'jsonwebtoken';
import { subscribe, sendUserEvent } from '../events/broadcaster.js';
import { runTikTokSearchForAccounts } from '../workers/tiktokSearchWorker.js';
import { runTikTokFeedForAccounts } from '../workers/tiktokFeedWorker.js';

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
    const [accounts]: any = await db.query(
      'SELECT id, account_identifier, is_active, last_used_at, actions_count FROM tiktok_accounts WHERE user_id = ?',
      [userId]
    );

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

    await db.query('INSERT INTO automation_state (user_id, is_running) VALUES (?, ?) ON DUPLICATE KEY UPDATE is_running = VALUES(is_running)', [userId, true])
    sendUserEvent(userId, { type: 'status', text: 'Automation started - scraping TikTok feed...' })
    
    // Use feed scraping instead of search (search is heavily rate-limited)
    runTikTokFeedForAccounts(userId).catch(err => {
      console.error('[Dashboard] TikTok feed scrape failed:', err)
      sendUserEvent(userId, { type: 'error', text: 'Failed to scrape TikTok feed' })
    })
    
    res.json({ message: 'Started' })
  } catch (err) {
    console.error('Start error', err)
    res.status(500).json({ message: 'Server error' })
  }
})

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


