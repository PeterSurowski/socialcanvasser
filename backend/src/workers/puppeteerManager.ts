import puppeteer from 'puppeteer'
import { sendUserEvent } from '../events/broadcaster.js'

type SessionEntry = {
  browser: puppeteer.Browser
  page: puppeteer.Page
}

const sessions: Map<number, SessionEntry> = new Map()

export async function startSession(accountId: number, userId: number) {
  sendUserEvent(userId, { type: 'info', text: `Opening browser for account ${accountId}. Please complete login in the opened window.` })
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  // Navigate to TikTok login
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})

  sessions.set(accountId, { browser, page })
  return { ok: true }
}

export async function finalizeSession(accountId: number, userId: number) {
  const entry = sessions.get(accountId)
  if (!entry) throw new Error('No active browser session for account')
  const { browser, page } = entry

  try {
    // Capture cookies
    const cookies = await page.cookies()
    // Close browser
    await browser.close()
    sessions.delete(accountId)
    sendUserEvent(userId, { type: 'success', text: `Captured ${cookies.length} cookies for account ${accountId}` })
    return { cookies }
  } catch (err) {
    try { await browser.close() } catch(e){}
    sessions.delete(accountId)
    sendUserEvent(userId, { type: 'error', text: `Failed capturing session for ${accountId}: ${String(err)}` })
    throw err
  }
}

export function cancelSession(accountId: number) {
  const entry = sessions.get(accountId)
  if (!entry) return
  try { entry.browser.close() } catch(e){}
  sessions.delete(accountId)
}
