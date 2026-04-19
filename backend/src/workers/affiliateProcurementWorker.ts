import db from '../config/database.js';
import { sendUserEvent } from '../events/broadcaster.js';
import {
  generateAffiliateComment,
  generateAffiliateProspectDM
} from '../services/openai.js';
import { tryToSendDM, hasContactedUser, recordContact, logActivity } from '../services/engagement.js';
import {
  connectBrowserForAccount,
  closeBrowserConnection,
  type BrowserConnection,
  type TikTokAccount
} from '../services/browserManager.js';
import type { Page } from 'puppeteer-core';

const FALLBACK_USERS_PER_SESSION = 20;
const WATCH_MIN_SECONDS = 2;
const WATCH_MAX_SECONDS = 12;

interface AffiliateRunState {
  keywordIndex: number;
  lastAccountId: number | null;
}

interface AffiliateConfig {
  keywords: string[];
  brandVoice: string;
  invitationText: string;
  snoozeDays: number;
  openaiApiKey: string;
  dmEdsThreshold: number;
}

interface ProspectRow {
  id: number;
  user_id: number;
  tiktok_username: string;
  profile_url: string;
  incogniton_account_id: number | null;
  engagement_depth_score: number;
  interaction_sessions: number;
  bio_scraped: number | boolean;
  bio_text: string | null;
  user_title: string | null;
  is_following: number | boolean;
  is_following_us: number | boolean;
  snoozed_until: string | null;
  dm_sent: number | boolean;
}

interface SearchVideoCandidate {
  href: string;
  creatorUsername: string;
  profileUrl: string;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTikTokUrl(href: string): string {
  return href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
}

function extractUsernameFromTikTokUrl(url: string): string | null {
  const match = url.match(/\/@([^/?]+)/);
  return match?.[1] || null;
}

async function isAffiliateAutomationRunning(userId: number): Promise<boolean> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT affiliate_is_running FROM automation_state WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const row = (rows as any[])[0];
    return row ? asBool(row.affiliate_is_running) : false;
  } finally {
    connection.release();
  }
}

async function setAffiliateRunning(userId: number, running: boolean): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO automation_state (user_id, affiliate_is_running)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE affiliate_is_running = VALUES(affiliate_is_running)`,
      [userId, running]
    );
  } finally {
    connection.release();
  }
}

async function loadAffiliateState(userId: number): Promise<AffiliateRunState> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT affiliate_keyword_index, affiliate_last_account_id
       FROM automation_state WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    const row = (rows as any[])[0];
    return {
      keywordIndex: row?.affiliate_keyword_index ?? 0,
      lastAccountId: row?.affiliate_last_account_id ?? null
    };
  } catch {
    return { keywordIndex: 0, lastAccountId: null };
  } finally {
    connection.release();
  }
}

async function saveAffiliateState(userId: number, keywordIndex: number, lastAccountId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO automation_state (user_id, affiliate_keyword_index, affiliate_last_account_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         affiliate_keyword_index = VALUES(affiliate_keyword_index),
         affiliate_last_account_id = VALUES(affiliate_last_account_id)`,
      [userId, keywordIndex, lastAccountId]
    );
  } catch {
  } finally {
    connection.release();
  }
}

async function getAffiliateConfig(userId: number): Promise<AffiliateConfig | null> {
  const connection = await db.getConnection();
  try {
    const [configRows] = await connection.query(
      `SELECT keywords, brand_voice, affiliate_invitation_text, snooze_days, openai_api_key, affiliate_dm_eds_threshold
       FROM user_config WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    const row = (configRows as any[])[0];
    if (!row) return null;

    const keywords: string[] = (row.keywords || '')
      .split(',')
      .map((k: string) => k.trim())
      .filter(Boolean);

    return {
      keywords,
      brandVoice: row.brand_voice || '',
      invitationText: row.affiliate_invitation_text || '',
      snoozeDays: row.snooze_days ?? 3,
      openaiApiKey: row.openai_api_key || '',
      dmEdsThreshold: row.affiliate_dm_eds_threshold ?? 4
    };
  } finally {
    connection.release();
  }
}

async function getAvailableAccounts(userId: number): Promise<any[]> {
  const connection = await db.getConnection();
  try {
    const [accountRows] = await connection.query(
      `SELECT id, account_identifier, browser_type, incogniton_profile_id, session_data,
              actions_per_session, current_session_actions, is_rate_limited,
              rate_limit_expires_at, is_paused
       FROM tiktok_accounts
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    return (accountRows as any[])
      .filter(a => {
        const snoozed =
          a.is_rate_limited &&
          a.rate_limit_expires_at &&
          new Date(a.rate_limit_expires_at) > new Date();
        return !snoozed && !a.is_paused;
      })
      .sort((a, b) => a.id - b.id);
  } finally {
    connection.release();
  }
}

async function getProspectsOrdered(userId: number): Promise<ProspectRow[]> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT *
       FROM affiliate_prospects
       WHERE user_id = ?
       ORDER BY created_at ASC`,
      [userId]
    );
    return rows as ProspectRow[];
  } finally {
    connection.release();
  }
}

async function getProspectById(prospectId: number): Promise<ProspectRow | null> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT * FROM affiliate_prospects WHERE id = ? LIMIT 1',
      [prospectId]
    );
    return ((rows as any[])[0] as ProspectRow) || null;
  } finally {
    connection.release();
  }
}

async function assignProspectToAccount(prospectId: number, accountId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `UPDATE affiliate_prospects
       SET incogniton_account_id = COALESCE(incogniton_account_id, ?)
       WHERE id = ?`,
      [accountId, prospectId]
    );
  } finally {
    connection.release();
  }
}

async function upsertProspectSeed(
  userId: number,
  username: string,
  profileUrl: string,
  accountId: number
): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO affiliate_prospects (user_id, tiktok_username, profile_url, incogniton_account_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         profile_url = VALUES(profile_url),
         incogniton_account_id = COALESCE(incogniton_account_id, VALUES(incogniton_account_id))`,
      [userId, username, profileUrl, accountId]
    );
  } finally {
    connection.release();
  }
}

async function updateProspectUsernameAndProfile(prospectId: number, username: string, profileUrl: string): Promise<void> {
  const connection = await db.getConnection();
  try {
    try {
      await connection.query(
        `UPDATE affiliate_prospects
         SET tiktok_username = ?, profile_url = ?
         WHERE id = ?`,
        [username, profileUrl, prospectId]
      );
    } catch {
      await connection.query(
        `UPDATE affiliate_prospects
         SET profile_url = ?
         WHERE id = ?`,
        [profileUrl, prospectId]
      );
    }
  } finally {
    connection.release();
  }
}

async function markProspectVisited(prospectId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `UPDATE affiliate_prospects
       SET engagement_depth_score = engagement_depth_score + 1,
           interaction_sessions = interaction_sessions + 1,
           last_interaction_at = NOW()
       WHERE id = ?`,
      [prospectId]
    );
  } finally {
    connection.release();
  }
}

async function addProspectEds(prospectId: number, points: number): Promise<void> {
  if (!points) return;
  const connection = await db.getConnection();
  try {
    await connection.query(
      `UPDATE affiliate_prospects
       SET engagement_depth_score = engagement_depth_score + ?,
           last_interaction_at = NOW()
       WHERE id = ?`,
      [points, prospectId]
    );
  } finally {
    connection.release();
  }
}

async function setProspectBio(prospectId: number, userTitle: string, bioText: string): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `UPDATE affiliate_prospects
       SET user_title = ?, bio_text = ?, bio_scraped = TRUE
       WHERE id = ?`,
      [userTitle || null, bioText || null, prospectId]
    );
  } finally {
    connection.release();
  }
}

async function setProspectFollowing(prospectId: number, isFollowing: boolean): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query('UPDATE affiliate_prospects SET is_following = ? WHERE id = ?', [isFollowing, prospectId]);
  } finally {
    connection.release();
  }
}

async function setProspectFollowedBackByUsername(userId: number, username: string): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      'UPDATE affiliate_prospects SET is_following_us = TRUE WHERE user_id = ? AND tiktok_username = ?',
      [userId, username]
    );
  } finally {
    connection.release();
  }
}

async function markProspectDmSent(prospectId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query('UPDATE affiliate_prospects SET dm_sent = TRUE, dm_sent_at = NOW() WHERE id = ?', [prospectId]);
  } finally {
    connection.release();
  }
}

async function snoozeProspect(prospectId: number, snoozeDays: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    const snoozedUntil = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000);
    await connection.query('UPDATE affiliate_prospects SET snoozed_until = ? WHERE id = ?', [snoozedUntil, prospectId]);
  } finally {
    connection.release();
  }
}

async function hasInteractedWithVideo(userId: number, videoUrl: string): Promise<boolean> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT id FROM affiliate_interacted_videos WHERE user_id = ? AND video_url = ? LIMIT 1',
      [userId, videoUrl]
    );
    return (rows as any[]).length > 0;
  } finally {
    connection.release();
  }
}

async function recordInteractedVideo(
  userId: number,
  videoUrl: string,
  tiktokUsername: string,
  caption: string | null,
  comments: string[],
  liked: boolean,
  commentPosted: boolean
): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO affiliate_interacted_videos
         (user_id, video_url, tiktok_username, caption, comments_json, liked, comment_posted)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tiktok_username = VALUES(tiktok_username),
         caption = COALESCE(VALUES(caption), caption),
         comments_json = COALESCE(VALUES(comments_json), comments_json),
         liked = liked OR VALUES(liked),
         comment_posted = comment_posted OR VALUES(comment_posted)`,
      [userId, videoUrl, tiktokUsername, caption, comments.length ? JSON.stringify(comments.slice(0, 10)) : null, liked, commentPosted]
    );
  } finally {
    connection.release();
  }
}

async function getRecentContextForProspect(userId: number, username: string): Promise<{ captions: string[]; comments: string[] }> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT caption, comments_json
       FROM affiliate_interacted_videos
       WHERE user_id = ? AND tiktok_username = ?
       ORDER BY interacted_at DESC
       LIMIT 5`,
      [userId, username]
    );

    const captions: string[] = [];
    const comments: string[] = [];

    for (const row of rows as any[]) {
      if (row.caption) captions.push(String(row.caption));
      if (row.comments_json) {
        try {
          const parsed = JSON.parse(row.comments_json);
          if (Array.isArray(parsed)) {
            for (const comment of parsed.slice(0, 5)) {
              comments.push(String(comment));
            }
          }
        } catch {
        }
      }
    }

    return { captions: captions.slice(0, 5), comments: comments.slice(0, 5) };
  } finally {
    connection.release();
  }
}

async function likeVideo(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      const likeCountEl =
        document.querySelector('[data-e2e="browse-like-count"]') ||
        document.querySelector('[data-e2e="like-count"]');
      if (!likeCountEl) return { success: false, reason: 'like-count element not found' };

      const btn = likeCountEl.closest('button') as HTMLButtonElement | null;
      if (!btn) return { success: false, reason: 'like button not found' };

      if (btn.getAttribute('aria-pressed') === 'true') {
        return { success: true, alreadyLiked: true };
      }

      btn.click();
      return { success: true, alreadyLiked: false };
    });

    if (result.success) {
      console.log(`[Affiliate] 👍 Like: ${result.alreadyLiked ? 'already liked' : 'liked successfully'}`);
      await delay(700);
      return true;
    }

    console.log(`[Affiliate] ⚠️ Could not like video: ${result.reason}`);
    return false;
  } catch (error) {
    console.log('[Affiliate] ⚠️ likeVideo error:', error);
    return false;
  }
}

async function openCommentsPanel(page: Page): Promise<void> {
  try {
    const commentsAlreadyOpen = await page.evaluate(() => {
      return document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-item"]').length > 0;
    });
    if (commentsAlreadyOpen) return;

    await page.evaluate(() => {
      const icon = document.querySelector('[data-e2e="comment-icon"]');
      const btn = icon?.closest('button') as HTMLButtonElement | null;
      if (btn) btn.click();
    });
    await delay(1500);
  } catch (error) {
    console.log('[Affiliate] ⚠️ openCommentsPanel error:', error);
  }
}

async function postFreshComment(page: Page, commentText: string): Promise<{ success: boolean; error?: string }> {
  try {
    const activated = await page.evaluate(() => {
      const placeholder =
        (document.querySelector('[data-e2e="add-comment"]') as HTMLElement | null) ||
        (document.querySelector('[data-e2e="comment-input-placeholder"]') as HTMLElement | null);
      if (placeholder) {
        placeholder.click();
        return { clicked: true };
      }

      const input = document.querySelector('[data-e2e="comment-input"] [contenteditable="true"]') as HTMLElement | null;
      if (input) {
        input.click();
        input.focus();
        return { clicked: true };
      }
      return { clicked: false };
    });

    if (!activated.clicked) {
      console.log('[Affiliate] ⚠️ Could not activate comment input');
    }

    await delay(800);

    const inputSelector = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="comment-input"] [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        '[class*="comment"] [contenteditable="true"]'
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (el) {
          el.focus();
          return selector;
        }
      }
      return null;
    });

    if (!inputSelector) {
      return { success: false, error: 'Comment input not found' };
    }

    await page.type(inputSelector, commentText, { delay: 45 });
    console.log(`[Affiliate] Typed comment: "${commentText.substring(0, 60)}..."`);

    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement | null;
        return btn && !btn.disabled && !btn.hasAttribute('disabled');
      },
      { timeout: 6000 }
    );

    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });

    if (!clicked) return { success: false, error: 'Failed to click Post' };

    await delay(1800);
    console.log('[Affiliate] ✅ Comment posted');
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function scrapeVideoContent(page: Page, maxComments = 10): Promise<{ caption: string; comments: string[]; username: string }> {
  return page.evaluate((max: number) => {
    const captionEl =
      document.querySelector('[data-e2e="browse-video-desc"]') ||
      document.querySelector('[data-e2e="video-desc"]');
    const caption = captionEl?.textContent?.trim() || '';

    const usernameEl =
      document.querySelector('[data-e2e="browse-username"]') ||
      document.querySelector('[data-e2e="creator-nickname"]');
    let username = usernameEl?.textContent?.trim().replace('@', '') || '';
    if (!username) {
      const match = window.location.href.match(/@([^/]+)/);
      username = match ? match[1] : '';
    }

    const commentEls = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-item"]')).slice(0, max);
    const comments = commentEls
      .map(el => {
        const textEl = el.querySelector('span.TUXText') || el.querySelector('span');
        return textEl?.textContent?.trim() || '';
      })
      .filter(Boolean);

    return { caption, comments, username };
  }, maxComments);
}

async function scrapeProfileBioAndTitle(page: Page): Promise<{ userTitle: string; bioText: string }> {
  return page.evaluate(() => {
    const title =
      (document.querySelector('[data-e2e="user-title"]') as HTMLElement | null)?.innerText?.trim() ||
      (document.querySelector('h1[data-e2e="user-title"]') as HTMLElement | null)?.innerText?.trim() ||
      '';

    const bio =
      (document.querySelector('[data-e2e="user-bio"]') as HTMLElement | null)?.innerText?.trim() ||
      (document.querySelector('[data-e2e="user-bio-description"]') as HTMLElement | null)?.innerText?.trim() ||
      '';

    return { userTitle: title, bioText: bio };
  });
}

async function tryFollowCurrentProfile(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="follow-button"]',
        '[data-e2e="follow-btn"]',
        'button[data-e2e*="follow"]'
      ];

      for (const selector of selectors) {
        const btn = document.querySelector(selector) as HTMLButtonElement | null;
        if (btn) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('following')) return { clicked: false, alreadyFollowing: true };
          btn.click();
          return { clicked: true, alreadyFollowing: false };
        }
      }

      const allButtons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
      const followBtn = allButtons.find(btn => {
        const text = (btn.textContent || '').trim().toLowerCase();
        return text === 'follow' || text === 'follow back';
      });

      if (!followBtn) return { clicked: false, alreadyFollowing: false };
      followBtn.click();
      return { clicked: true, alreadyFollowing: false };
    });

    if (result.alreadyFollowing) return true;
    if (result.clicked) {
      await delay(1000);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function getSearchVideoCandidates(page: Page, keyword: string): Promise<SearchVideoCandidate[]> {
  await delay(2500);

  try {
    await page.waitForFunction(
      () => {
        const skeletons = document.querySelectorAll('[data-e2e="video-skeleton-container"]');
        const cards = document.querySelectorAll('[data-e2e="search_top-item"], [data-e2e="feed-video"]');
        const links = document.querySelectorAll('a[href*="/video/"]');
        return (skeletons.length === 0 && cards.length > 0) || links.length > 0;
      },
      { timeout: 15000 }
    );
  } catch {
    console.log(`[Affiliate Worker] Search results render wait timed out for keyword "${keyword}"`);
  }

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await delay(1100);
  }

  const rawUrls: string[] = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-e2e="search_top-item"], [data-e2e="feed-video"]'));
    const cardUrls = cards
      .map(card => {
        const link = card.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
        return link?.getAttribute('href') || '';
      })
      .filter(Boolean);

    if (cardUrls.length > 0) {
      return cardUrls.slice(0, 120);
    }

    const fallback = Array.from(document.querySelectorAll('a[href*="/video/"]')) as HTMLAnchorElement[];
    return fallback
      .map(link => link.getAttribute('href') || '')
      .filter(Boolean)
      .slice(0, 120);
  });

  const seenUrl = new Set<string>();
  const seenCreators = new Set<string>();
  const candidates: SearchVideoCandidate[] = [];

  for (const url of rawUrls) {
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);

    const creatorUsername = extractUsernameFromTikTokUrl(url);
    if (!creatorUsername) continue;

    const creatorLower = creatorUsername.toLowerCase();
    if (seenCreators.has(creatorLower)) continue;
    seenCreators.add(creatorLower);

    candidates.push({
      href: url,
      creatorUsername,
      profileUrl: `https://www.tiktok.com/@${creatorUsername}`
    });
  }

  return candidates;
}

async function getProfileVideoUrls(page: Page): Promise<string[]> {
  await delay(1500);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
    await delay(900);
  }

  const hrefs: string[] = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/video/"]')) as HTMLAnchorElement[];
    return links.map(link => link.getAttribute('href') || '').filter(Boolean).slice(0, 80);
  });

  const seen = new Set<string>();
  const output: string[] = [];
  for (const href of hrefs) {
    const normalized = normalizeTikTokUrl(href);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

async function getProfileVideoUrlsForCreator(page: Page, creatorUsername: string): Promise<string[]> {
  const urls = await getProfileVideoUrls(page);
  const target = creatorUsername.toLowerCase();
  return urls.filter(url => url.toLowerCase().includes(`/@${target}/video/`));
}

async function seedProspectsFromKeyword(
  page: Page,
  userId: number,
  accountId: number,
  keywords: string[],
  keywordIndexRef: { value: number }
): Promise<number> {
  if (!keywords.length) return 0;

  const keyword = keywords[keywordIndexRef.value % keywords.length];
  keywordIndexRef.value += 1;

  sendUserEvent(userId, {
    type: 'info',
    text: `🔍 Affiliate: searching "${keyword}" for new prospects`
  });

  const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch {
    console.log(`[Affiliate Worker] Search navigation timeout for keyword "${keyword}"`);
  }

  const candidates = await getSearchVideoCandidates(page, keyword);
  console.log(`[Affiliate Worker] Found ${candidates.length} videos for keyword "${keyword}"`);

  let seeded = 0;
  for (const candidate of candidates) {
    await upsertProspectSeed(userId, candidate.creatorUsername, candidate.profileUrl, accountId);
    seeded++;
  }

  return seeded;
}

async function watchRandomVideos(page: Page, videoUrls: string[]): Promise<void> {
  if (!videoUrls.length) return;

  const count = Math.min(videoUrls.length, randomInt(1, 3));
  for (let i = 0; i < count; i++) {
    const url = videoUrls[i];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('[data-e2e="browse-video"], [data-e2e="browse-username"], video', { timeout: 12000 });
    } catch {
      continue;
    }

    const watchSeconds = randomInt(WATCH_MIN_SECONDS, WATCH_MAX_SECONDS);
    await delay(watchSeconds * 1000);
  }
}

async function processNotificationsAndScore(
  page: Page,
  userId: number
): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="nav-activity"]') as HTMLElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (!clicked) return;

    await delay(2500);

    const activityText = await page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll('[data-e2e*="notification"], [data-e2e*="activity"]'))
        .map(el => (el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 30);

      if (blocks.length) return blocks;

      return (document.body.innerText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 120);
    });

    const prospects = await getProspectsOrdered(userId);
    for (const prospect of prospects) {
      const username = prospect.tiktok_username.toLowerCase();
      const matchingLines = activityText.filter(line => line.toLowerCase().includes(username));
      if (!matchingLines.length) continue;

      let points = 0;
      let followedBack = false;

      for (const line of matchingLines) {
        const lower = line.toLowerCase();
        if (lower.includes('liked your comment')) points += 1;
        if (lower.includes('replied to your comment')) points += 2;
        if (lower.includes('liked your video')) points += 1;
        if (lower.includes('followed you') || lower.includes('started following you')) {
          points += 5;
          followedBack = true;
        }
      }

      if (points > 0) {
        await addProspectEds(prospect.id, points);
      }
      if (followedBack) {
        await setProspectFollowedBackByUsername(userId, prospect.tiktok_username);
      }
    }
  } catch (error) {
    console.log('[Affiliate Worker] Notification scrape/scoring failed:', error);
  }
}

async function findNextEligibleProspect(
  userId: number,
  accountId: number
): Promise<ProspectRow | null> {
  const prospects = await getProspectsOrdered(userId);
  const now = new Date();

  for (const prospect of prospects) {
    if (prospect.snoozed_until && new Date(prospect.snoozed_until) > now) {
      continue;
    }

    if (prospect.incogniton_account_id && prospect.incogniton_account_id !== accountId) {
      continue;
    }

    return prospect;
  }

  return null;
}

async function processProspect(
  page: Page,
  userId: number,
  account: any,
  config: AffiliateConfig,
  prospectInput: ProspectRow
): Promise<boolean> {
  let prospect = prospectInput;

  if (!prospect.incogniton_account_id) {
    await assignProspectToAccount(prospect.id, account.id);
  }

  let canonicalUsername = prospect.tiktok_username;
  let profileUrl = prospect.profile_url || `https://www.tiktok.com/@${canonicalUsername}`;

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    return false;
  }

  const landedUrl = page.url();
  const landedUsername = extractUsernameFromTikTokUrl(landedUrl);
  if (!landedUsername) {
    return false;
  }

  if (landedUsername.toLowerCase() !== canonicalUsername.toLowerCase()) {
    canonicalUsername = landedUsername;
    profileUrl = `https://www.tiktok.com/@${canonicalUsername}`;
    await updateProspectUsernameAndProfile(prospect.id, canonicalUsername, profileUrl);
  }

  prospect = (await getProspectById(prospect.id)) || prospect;

  if (!asBool(prospect.bio_scraped)) {
    const profileData = await scrapeProfileBioAndTitle(page);
    await setProspectBio(prospect.id, profileData.userTitle, profileData.bioText);
    prospect.user_title = profileData.userTitle || null;
    prospect.bio_text = profileData.bioText || null;
  }

  await markProspectVisited(prospect.id);

  const profileVideoUrls = await getProfileVideoUrlsForCreator(page, canonicalUsername);
  if (!profileVideoUrls.length) {
    await snoozeProspect(prospect.id, config.snoozeDays);
    return true;
  }

  await watchRandomVideos(page, profileVideoUrls);

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch {
    return true;
  }

  const refreshedVideoUrls = await getProfileVideoUrlsForCreator(page, canonicalUsername);
  if (!refreshedVideoUrls.length) {
    await snoozeProspect(prospect.id, config.snoozeDays);
    return true;
  }

  let targetVideoUrl: string | null = null;
  for (const candidate of refreshedVideoUrls) {
    if (!(await hasInteractedWithVideo(userId, candidate))) {
      targetVideoUrl = candidate;
      break;
    }
  }

  if (!targetVideoUrl) {
    await snoozeProspect(prospect.id, config.snoozeDays);
    return true;
  }

  try {
    await page.goto(targetVideoUrl, { waitUntil: 'networkidle2', timeout: 22000 });
    await page.waitForSelector('[data-e2e="browse-video"], [data-e2e="browse-username"], video', { timeout: 12000 });
  } catch {
    return true;
  }

  const liked = await likeVideo(page);
  if (liked) {
    await addProspectEds(prospect.id, 1);
  }

  let commentPosted = false;
  let caption = '';
  let comments: string[] = [];

  if (Math.random() < 0.5) {
    await openCommentsPanel(page);
    await delay(1200);

    const content = await scrapeVideoContent(page, 10);
    caption = content.caption || '';
    comments = content.comments || [];

    if (caption || comments.length) {
      let generatedComment = '';
      try {
        generatedComment = await generateAffiliateComment(
          caption,
          comments,
          config.brandVoice,
          config.openaiApiKey
        );
      } catch (error) {
        console.log('[Affiliate Worker] OpenAI comment generation failed:', error);
      }

      if (generatedComment) {
        const result = await postFreshComment(page, generatedComment);
        if (result.success) {
          commentPosted = true;
          await addProspectEds(prospect.id, 1);
          await logActivity(
            userId,
            account.id,
            'affiliate_comment_posted',
            canonicalUsername,
            targetVideoUrl,
            generatedComment,
            true
          );
          sendUserEvent(userId, {
            type: 'success',
            text: `✅ Affiliate comment posted on @${canonicalUsername}'s video`
          });
        }
      }
    }
  }

  const latestProspect = await getProspectById(prospect.id);
  if (latestProspect && !asBool(latestProspect.is_following) && Math.random() < 0.05) {
    const followed = await tryFollowCurrentProfile(page);
    if (followed) {
      await setProspectFollowing(prospect.id, true);
      await addProspectEds(prospect.id, 1);
    }
  }

  await recordInteractedVideo(
    userId,
    targetVideoUrl,
    canonicalUsername,
    caption || null,
    comments,
    liked,
    commentPosted
  );

  await snoozeProspect(prospect.id, config.snoozeDays);

  const refreshedProspect = await getProspectById(prospect.id);
  const dmSent = refreshedProspect ? asBool(refreshedProspect.dm_sent) : false;
  const currentEds = refreshedProspect?.engagement_depth_score ?? 0;

  if (!dmSent && currentEds >= config.dmEdsThreshold && config.invitationText?.trim() && Math.random() < 0.5) {
    const alreadyContacted = await hasContactedUser(userId, canonicalUsername);
    if (!alreadyContacted) {
      const context = await getRecentContextForProspect(userId, canonicalUsername);

      let dmText = config.invitationText;
      try {
        const generatedDm = await generateAffiliateProspectDM(
          canonicalUsername,
          refreshedProspect?.user_title || '',
          refreshedProspect?.bio_text || '',
          context.captions,
          context.comments,
          config.invitationText,
          config.brandVoice,
          config.openaiApiKey
        );

        if (generatedDm?.trim()) {
          dmText = generatedDm.trim();
        }
      } catch (error) {
        console.log('[Affiliate Worker] Personalized DM generation failed, using fallback text:', error);
      }

      const dmResult = await tryToSendDM(page, canonicalUsername, dmText);
      if (dmResult.success) {
        await recordContact(userId, canonicalUsername, 'dm', account.id, profileUrl);
        await logActivity(
          userId,
          account.id,
          'affiliate_dm_sent',
          canonicalUsername,
          profileUrl,
          dmText,
          true
        );
        await markProspectDmSent(prospect.id);
        sendUserEvent(userId, {
          type: 'success',
          text: `✅ Affiliate DM sent to @${canonicalUsername}`
        });
      }
    }
  }

  return true;
}

export async function runAffiliateProcurementForAccounts(userId: number): Promise<void> {
  const config = await getAffiliateConfig(userId);
  if (!config) {
    sendUserEvent(userId, { type: 'error', text: '❌ Affiliate: No config found.' });
    return;
  }

  if (!config.keywords.length) {
    sendUserEvent(userId, { type: 'error', text: '❌ Affiliate: No keywords configured.' });
    return;
  }

  if (!config.openaiApiKey) {
    sendUserEvent(userId, { type: 'error', text: '❌ Affiliate: OpenAI API key not set.' });
    return;
  }

  const accounts = await getAvailableAccounts(userId);
  if (!accounts.length) {
    sendUserEvent(userId, {
      type: 'error',
      text: '❌ Affiliate: No available accounts. Check pause/rate-limit status.'
    });
    return;
  }

  const state = await loadAffiliateState(userId);
  const keywordIndexRef = { value: state.keywordIndex };

  let accountCursor = 0;
  if (state.lastAccountId !== null) {
    const idx = accounts.findIndex(a => a.id === state.lastAccountId);
    if (idx !== -1) {
      accountCursor = (idx + 1) % accounts.length;
    }
  }

  while (await isAffiliateAutomationRunning(userId)) {
    const account = accounts[accountCursor % accounts.length];
    accountCursor += 1;

    let browserConnection: BrowserConnection | null = null;
    let sessionCount = 0;

    const maxUsersPerSession = Math.max(
      1,
      Number(account.actions_per_session || FALLBACK_USERS_PER_SESSION)
    );

    try {
      sendUserEvent(userId, {
        type: 'info',
        text: `🤝 Affiliate: starting relationship session with @${account.account_identifier}`
      });

      browserConnection = await connectBrowserForAccount(account as TikTokAccount);
      const page = browserConnection.page;

      sendUserEvent(userId, {
        type: 'info',
        text: `🔔 Affiliate: checking notifications on @${account.account_identifier}`
      });

      try {
        await page.goto('https://tiktok.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        console.log(`[Affiliate Worker] Initial TikTok home navigation failed for @${account.account_identifier}`);
      }

      await processNotificationsAndScore(page, userId);

      while ((await isAffiliateAutomationRunning(userId)) && sessionCount < maxUsersPerSession) {
        let prospect = await findNextEligibleProspect(userId, account.id);

        if (!prospect) {
          const seeded = await seedProspectsFromKeyword(
            page,
            userId,
            account.id,
            config.keywords,
            keywordIndexRef
          );

          if (seeded === 0) {
            await delay(2500);
            break;
          }

          prospect = await findNextEligibleProspect(userId, account.id);
          if (!prospect) {
            await delay(1000);
            continue;
          }
        }

        const processed = await processProspect(page, userId, account, config, prospect);
        if (processed) {
          sessionCount += 1;
        }

        const notificationInterval = maxUsersPerSession;
        if (sessionCount > 0 && sessionCount % notificationInterval === 0) {
          await processNotificationsAndScore(page, userId);
        }

        await delay(1500);
      }

      await saveAffiliateState(userId, keywordIndexRef.value, account.id);

      sendUserEvent(userId, {
        type: 'success',
        text: `✅ Affiliate: @${account.account_identifier} relationship session complete (${sessionCount} users visited)`
      });
    } catch (error) {
      console.error(`[Affiliate Worker] Error on account ${account.id}:`, error);
      sendUserEvent(userId, {
        type: 'error',
        text: `❌ Affiliate error on @${account.account_identifier}: ${error instanceof Error ? error.message : 'Unknown'}`
      });
    } finally {
      if (browserConnection) {
        try {
          await closeBrowserConnection(browserConnection);
        } catch {
        }
      }
    }

    await delay(2000);
  }

  sendUserEvent(userId, {
    type: 'status',
    text: '🔴 Affiliate Procurement stopped'
  });
}

export { setAffiliateRunning, isAffiliateAutomationRunning };
