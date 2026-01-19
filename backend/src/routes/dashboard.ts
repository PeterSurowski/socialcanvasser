import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';

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
