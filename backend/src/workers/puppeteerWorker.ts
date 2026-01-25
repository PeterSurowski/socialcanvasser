import puppeteer from 'puppeteer'
import db from '../config/database.js'
import { sendUserEvent } from '../events/broadcaster.js'

export async function captureSessionForAccount(accountId: number, userId: number) {
  sendUserEvent(userId, { type: 'info', text: `Starting session capture for account ${accountId}` })

  const connection = await db.getConnection()
  try {
    const [rows]: any = await connection.query('SELECT id, session_data, account_identifier FROM tiktok_accounts WHERE id = ?', [accountId])
    if (!rows || rows.length === 0) throw new Error('Account not found')
    const acct = rows[0]

    // In this prototype we check for manual credentials in session_data
    let creds: any = null
    try { creds = acct.session_data ? JSON.parse(acct.session_data) : null } catch(e) { creds = null }

    if (!creds || creds.type !== 'manual' || !creds.username || !creds.password) {
      // nothing to do; mark placeholder
      await connection.query('UPDATE tiktok_accounts SET session_data = ?, is_active = ?, last_checked = NOW() WHERE id = ?', [JSON.stringify({ type: 'browser', status: 'captured_placeholder' }), true, accountId])
      sendUserEvent(userId, { type: 'error', text: `No manual credentials for account ${accountId}; saved placeholder session.` })
      return { ok: true }
    }

    sendUserEvent(userId, { type: 'info', text: `Launching browser for ${acct.account_identifier}` })
    // Attempt a login using Puppeteer (best-effort; tiktok may block headless)
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    try {
      await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2', timeout: 60000 })
      // NOTE: TikTok's login flow is complex; this is a simplified attempt and may require adjustments.
      await sendUserEvent(userId, { type: 'info', text: `Opened login page for ${acct.account_identifier}` })

      // Wait a short time for manual/interactive or auto-fill to occur
      await page.waitForTimeout(8000)

      // Capture cookies
      const cookies = await page.cookies()
      await connection.query('UPDATE tiktok_accounts SET session_data = ?, session_expires_at = ?, is_active = ?, last_checked = NOW() WHERE id = ?', [JSON.stringify({ type: 'cookies', cookies }), null, true, accountId])
      sendUserEvent(userId, { type: 'success', text: `Captured ${cookies.length} cookies for ${acct.account_identifier}` })
    } catch (err) {
      sendUserEvent(userId, { type: 'error', text: `Puppeteer error for ${acct.account_identifier}: ${String(err)}` })
      throw err
    } finally {
      await browser.close()
    }

    return { ok: true }
  } finally {
    connection.release()
  }
}
