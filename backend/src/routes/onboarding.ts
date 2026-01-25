import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import db from '../config/database.js';
import { captureSessionForAccount } from '../workers/puppeteerWorker.js';
import { startSession, finalizeSession, cancelSession } from '../workers/puppeteerManager.js';
import { startContainerForAccount, stopContainer } from '../infra/dockerManager.js';

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

// Start a browser connect flow. Placeholder: creates an account record and returns a login URL.
router.post('/tiktok/connect', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { nickname } = req.body;
    if (!nickname) return res.status(400).json({ message: 'Nickname required' });

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
      // Insert a placeholder account record; session will be captured by Puppeteer later
      const [result] = await connection.query(
        'INSERT INTO tiktok_accounts (user_id, account_identifier, is_active) VALUES (?, ?, ?) ',
        [userId, nickname, false]
      );

      await connection.commit();
      connection.release();

      const acctId = (result as any).insertId
      // Start a browser container for the user to log in via noVNC; map ports per-account
      try {
        const { containerId, hostPort, debugPort } = await startContainerForAccount(acctId, nickname)
        // Persist container info in session_data
        const connection2 = await db.getConnection()
        await connection2.query('UPDATE tiktok_accounts SET session_data = ? WHERE id = ?', [JSON.stringify({ type: 'container', containerId, hostPort, debugPort }), acctId])
        connection2.release()
        return res.json({ message: 'Container started', accountId: acctId, url: `http://${req.headers.host?.split(':')[0] || 'localhost'}:${hostPort}/`, hostPort, debugPort })
      } catch (err) {
        console.error('start container error', err)
        return res.status(500).json({ message: 'Failed to start container', error: (err as any).message })
      }
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

// Save manual credentials for an account (placeholder). Backend should encrypt credentials in production.
router.post('/tiktok/manual', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { nickname, username, password } = req.body;
    if (!nickname || !username || !password) return res.status(400).json({ message: 'Missing fields' });

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
      // Store a JSON blob in session_data; in real app encrypt this
      const blob = JSON.stringify({ type: 'manual', username: username, note: 'credentials stored (encrypt in production)' });
      await connection.query(
        'INSERT INTO tiktok_accounts (user_id, account_identifier, session_data, is_active) VALUES (?, ?, ?, ?)',
        [userId, nickname, blob, true]
      );
      await connection.commit();
      connection.release();
      return res.json({ message: 'Saved' });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('tiktok manual error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Finalize a browser-based connect flow. Placeholder marks the account active and stores a small session marker.
router.post('/tiktok/complete', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    const { nickname, accountId } = req.body as { nickname?: string; accountId?: number };
    if (!nickname && !accountId) return res.status(400).json({ message: 'Nickname or accountId required' });

    const connection = await db.getConnection();
    await connection.beginTransaction();
    try {
      // Find the account by id if provided, otherwise by nickname
      let rows: any[] = [];
      if (accountId) {
        const [r] = await connection.query('SELECT id, account_identifier FROM tiktok_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        rows = r as any[];
      } else {
        const [r] = await connection.query('SELECT id, account_identifier FROM tiktok_accounts WHERE user_id = ? AND account_identifier = ? LIMIT 1', [userId, nickname]);
        rows = r as any[];
      }

      if (!rows || rows.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ message: 'Account not found' });
      }

      const acctId = rows[0].id;

      // Try to capture cookies by connecting to the container's debug port (if present in session_data)
      try {
        // fetch container info
        const [r2] = await connection.query('SELECT session_data FROM tiktok_accounts WHERE id = ? LIMIT 1', [acctId])
        const row = (r2 as any[])[0]
        let info = null
        try { info = row.session_data ? JSON.parse(row.session_data) : null } catch(e) { info = null }

        if (info && info.type === 'container' && info.debugPort) {
          // connect via puppeteer to http://localhost:debugPort
          const puppeteer = await import('puppeteer')
          try {
            const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${info.debugPort}` })
            const page = await browser.newPage()
            await page.goto('https://www.tiktok.com', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
            const cookies = await page.cookies()
            await connection.query('UPDATE tiktok_accounts SET session_data = ?, is_active = ?, last_checked = NOW() WHERE id = ?', [JSON.stringify({ type: 'cookies', cookies }), true, acctId]);
            await browser.disconnect()
            await connection.commit();
            connection.release();
            return res.json({ message: 'Session captured', accountId: acctId, cookieCount: cookies.length });
          } catch (err) {
            console.error('puppeteer connect error', err)
            // fallback
          }
        }

        // fallback placeholder
        const sessionBlob = JSON.stringify({ type: 'browser', status: 'captured_placeholder' });
        await connection.query('UPDATE tiktok_accounts SET session_data = ?, is_active = ?, last_checked = NOW() WHERE id = ?', [sessionBlob, true, acctId]);
        await connection.commit();
        connection.release();
        return res.json({ message: 'Session saved (placeholder)', accountId: acctId });
      } catch (err) {
        await connection.rollback();
        connection.release();
        console.error('finalize capture error', err)
        const msg = err && (err as any).message ? (err as any).message : String(err)
        return res.status(500).json({ message: 'Capture failed', error: msg })
      }
    } catch (err) {
      await connection.rollback();
      connection.release();
      console.error('tiktok complete inner error', err);
      const msg = err && (err as any).message ? (err as any).message : String(err);
      return res.status(500).json({ message: 'Server error (inner)', error: msg });
    }
  } catch (err) {
    console.error('tiktok complete error', err);
    const msg = err && (err as any).message ? (err as any).message : String(err);
    return res.status(500).json({ message: 'Server error', error: msg });
  }
});

// Trigger session capture for an account (manual invocation)
router.post('/tiktok/capture', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId as number
    const { accountId } = req.body
    if (!accountId) return res.status(400).json({ message: 'accountId required' })

    // Run the capture (best-effort)
    try {
      await captureSessionForAccount(parseInt(accountId, 10), userId)
      return res.json({ message: 'Capture initiated' })
    } catch (err) {
      console.error('capture error', err)
      return res.status(500).json({ message: 'Capture failed', error: (err as any).message })
    }
  } catch (err) {
    console.error('tiktok capture endpoint error', err)
    return res.status(500).json({ message: 'Server error' })
  }
})

export default router;
