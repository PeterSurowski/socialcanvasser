import db from '../config/database.js';
import { sendUserEvent } from '../events/broadcaster.js';
import {
  analyzeCommentsForBuyingIntent,
  classifyStatusUnknownProspect,
  generateAffiliateComment,
  generateAffiliateProspectDM
} from '../services/openai.js';
import { tryToSendDM, hasContactedUser, recordContact, logActivity, postCommentReply } from '../services/engagement.js';
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
  snoozeDays: number;
  keepInTouchSnoozeDays: number;
  openaiApiKey: string;
  dmEdsThreshold: number;
  minAffiliateFollowers: number;
}

interface GroupPromptConfig {
  aiPrompt: string;
  exampleDM: string;
  exampleComment: string;
  brandVoice: string;
  affiliateDmPrompt: string;
  affiliateInvitationText: string;
}

interface AccountWithGroup {
  id: number;
  account_identifier: string;
  browser_type: string;
  incogniton_profile_id: string | null;
  session_data: string | null;
  actions_per_session: number;
  current_session_actions: number;
  is_rate_limited: number | boolean;
  rate_limit_expires_at: string | null;
  is_paused: number | boolean;
  group_id: number | null;
  group_name: string | null;
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
  follower_count: number | null;
  prospect_type: ProspectType | null;
  bio_text: string | null;
  user_title: string | null;
  is_following: number | boolean;
  is_following_us: number | boolean;
  is_keep_in_touch: number | boolean;
  is_ignore_list: number | boolean;
  snoozed_until: string | null;
  dm_sent: number | boolean;
}

type ProspectType = 'prospective_affiliate' | 'prospective_customer' | 'status_unknown' | 'disqualified';

interface ScrapedComment {
  username: string;
  text: string;
  relativeTime: string;
  profileUrl: string;
}

interface SearchVideoCandidate {
  href: string;
  creatorUsername: string;
  profileUrl: string;
}

interface Tier1SelectionResult {
  prospect: ProspectRow | null;
  allReachableProspectsSnoozed: boolean;
  reachableProspectCount: number;
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

function parseFollowerCount(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const text = String(raw).trim().toUpperCase().replace(/,/g, '');
  const match = text.match(/([0-9]*\.?[0-9]+)\s*([KMB])?/);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  const suffix = match[2] || '';
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  return Math.round(base * multiplier);
}

function parseRelativeTimeToDays(relativeTime: string): number {
  const text = String(relativeTime || '').trim().toLowerCase();
  if (!text) return Number.POSITIVE_INFINITY;

  if (text.includes('just now') || text.includes('sec') || text.includes('s')) {
    return 0;
  }

  const m = text.match(/(\d+)\s*(m|min|mins|minute|minutes)\b/);
  if (m) return Number(m[1]) / (60 * 24);

  const h = text.match(/(\d+)\s*(h|hr|hrs|hour|hours)\b/);
  if (h) return Number(h[1]) / 24;

  const d = text.match(/(\d+)\s*(d|day|days)\b/);
  if (d) return Number(d[1]);

  const w = text.match(/(\d+)\s*(w|wk|week|weeks)\b/);
  if (w) return Number(w[1]) * 7;

  const mo = text.match(/(\d+)\s*(mo|month|months)\b/);
  if (mo) return Number(mo[1]) * 30;

  const y = text.match(/(\d+)\s*(y|yr|year|years)\b/);
  if (y) return Number(y[1]) * 365;

  // TikTok sometimes returns month-day with no year (e.g., "4-21").
  // Interpret as the most recent occurrence of that date.
  const md = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const now = new Date();
      const currentYear = now.getFullYear();
      let candidate = new Date(currentYear, month - 1, day);

      // If date is in the future relative to now, assume previous year.
      if (candidate.getTime() > now.getTime()) {
        candidate = new Date(currentYear - 1, month - 1, day);
      }

      const diffMs = now.getTime() - candidate.getTime();
      return diffMs >= 0 ? diffMs / (1000 * 60 * 60 * 24) : Number.POSITIVE_INFINITY;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function isCommentRecentWithin7Days(relativeTime: string): boolean {
  return parseRelativeTimeToDays(relativeTime) <= 7;
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

async function getGroupLastProcessedProspectId(userId: number, groupId: number | null): Promise<number | null> {
  if (!groupId) return null;

  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT last_processed_prospect_id
       FROM affiliate_group_state
       WHERE user_id = ? AND group_id = ?
       LIMIT 1`,
      [userId, groupId]
    );

    return Number((rows as any[])[0]?.last_processed_prospect_id || 0) || null;
  } finally {
    connection.release();
  }
}

async function setGroupLastProcessedProspectId(userId: number, groupId: number | null, prospectId: number): Promise<void> {
  if (!groupId) return;

  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO affiliate_group_state (user_id, group_id, last_processed_prospect_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_processed_prospect_id = VALUES(last_processed_prospect_id),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, groupId, prospectId]
    );
  } finally {
    connection.release();
  }
}

async function getAffiliateConfig(userId: number): Promise<AffiliateConfig | null> {
  const connection = await db.getConnection();
  try {
    const [configRows] = await connection.query(
      `SELECT keywords, snooze_days, keep_in_touch_snooze_days, openai_api_key, affiliate_dm_eds_threshold, min_affiliate_followers
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
      snoozeDays: row.snooze_days ?? 3,
      keepInTouchSnoozeDays: row.keep_in_touch_snooze_days ?? 14,
      openaiApiKey: row.openai_api_key || '',
      dmEdsThreshold: row.affiliate_dm_eds_threshold ?? 4,
      minAffiliateFollowers: row.min_affiliate_followers ?? 2000
    };
  } finally {
    connection.release();
  }
}

async function getGroupPromptConfig(userId: number, groupId: number | null): Promise<GroupPromptConfig | null> {
  if (!groupId) {
    return null;
  }

  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT ai_prompt, example_dm, example_comment, brand_voice, affiliate_dm_prompt, affiliate_invitation_text
       FROM group_prompt_config
       WHERE user_id = ? AND group_id = ?
       LIMIT 1`,
      [userId, groupId]
    );

    const row = (rows as any[])[0];
    if (!row) {
      return null;
    }

    return {
      aiPrompt: String(row.ai_prompt || ''),
      exampleDM: String(row.example_dm || ''),
      exampleComment: String(row.example_comment || ''),
      brandVoice: String(row.brand_voice || ''),
      affiliateDmPrompt: String(row.affiliate_dm_prompt || ''),
      affiliateInvitationText: String(row.affiliate_invitation_text || '')
    };
  } finally {
    connection.release();
  }
}

async function getAvailableAccounts(userId: number): Promise<AccountWithGroup[]> {
  const connection = await db.getConnection();
  try {
    const [accountRows] = await connection.query(
      `SELECT ta.id, ta.account_identifier, ta.browser_type, ta.incogniton_profile_id, ta.session_data,
              actions_per_session, current_session_actions, is_rate_limited,
              rate_limit_expires_at, is_paused,
              ta.group_id, ag.name AS group_name
       FROM tiktok_accounts ta
       LEFT JOIN account_groups ag ON ag.id = ta.group_id
       WHERE ta.user_id = ? AND ta.is_active = 1`,
      [userId]
    );

    return (accountRows as AccountWithGroup[])
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

async function getProspectCount(userId: number): Promise<number> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM affiliate_prospects
       WHERE user_id = ?`,
      [userId]
    );
    return Number((rows as any[])[0]?.total || 0);
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

async function getStatusUnknownProspects(userId: number): Promise<ProspectRow[]> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT * FROM affiliate_prospects
       WHERE user_id = ? AND prospect_type = 'status_unknown'
       ORDER BY updated_at ASC`,
      [userId]
    );
    return rows as ProspectRow[];
  } finally {
    connection.release();
  }
}

async function updateProspectClassification(
  prospectId: number,
  patch: { followerCount?: number | null; prospectType?: ProspectType | null; userTitle?: string | null; bioText?: string | null }
): Promise<void> {
  const connection = await db.getConnection();
  try {
    const fields: string[] = [];
    const values: Array<number | string | null> = [];

    if ('followerCount' in patch) {
      fields.push('follower_count = ?');
      values.push(patch.followerCount ?? null);
    }
    if ('prospectType' in patch) {
      fields.push('prospect_type = ?');
      values.push(patch.prospectType ?? null);
    }
    if ('userTitle' in patch) {
      fields.push('user_title = ?');
      values.push(patch.userTitle ?? null);
    }
    if ('bioText' in patch) {
      fields.push('bio_text = ?');
      values.push(patch.bioText ?? null);
    }

    fields.push('bio_scraped = TRUE');
    if (!fields.length) return;

    values.push(prospectId);
    await connection.query(`UPDATE affiliate_prospects SET ${fields.join(', ')} WHERE id = ?`, values);
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

async function ensureGroupProspectAssignment(
  userId: number,
  groupId: number,
  prospectId: number,
  accountId: number
): Promise<'assigned' | 'already_assigned_same_account' | 'assigned_other_account'> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT assigned_account_id
       FROM affiliate_group_assignments
       WHERE user_id = ? AND group_id = ? AND prospect_id = ?
       LIMIT 1`,
      [userId, groupId, prospectId]
    );

    const row = (rows as any[])[0];
    if (row) {
      if (Number(row.assigned_account_id) === accountId) {
        return 'already_assigned_same_account';
      }
      return 'assigned_other_account';
    }

    await connection.query(
      `INSERT INTO affiliate_group_assignments (user_id, group_id, prospect_id, assigned_account_id)
       VALUES (?, ?, ?, ?)`,
      [userId, groupId, prospectId, accountId]
    );

    return 'assigned';
  } finally {
    connection.release();
  }
}

async function getGroupAssignmentMap(userId: number, groupId: number | null): Promise<Map<number, number>> {
  const assignmentMap = new Map<number, number>();
  if (!groupId) {
    return assignmentMap;
  }

  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT prospect_id, assigned_account_id
       FROM affiliate_group_assignments
       WHERE user_id = ? AND group_id = ?`,
      [userId, groupId]
    );

    for (const row of rows as any[]) {
      const prospectId = Number(row.prospect_id || 0);
      const assignedAccountId = Number(row.assigned_account_id || 0);
      if (prospectId && assignedAccountId) {
        assignmentMap.set(prospectId, assignedAccountId);
      }
    }

    return assignmentMap;
  } finally {
    connection.release();
  }
}

async function upsertProspectSeed(
  userId: number,
  username: string,
  profileUrl: string,
  accountId: number,
  groupId: number | null
): Promise<void> {
  const connection = await db.getConnection();
  try {
    const [result] = await connection.query(
      `INSERT INTO affiliate_prospects (user_id, tiktok_username, profile_url, incogniton_account_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         profile_url = VALUES(profile_url),
         incogniton_account_id = COALESCE(incogniton_account_id, VALUES(incogniton_account_id))`,
      [userId, username, profileUrl, accountId]
    );

    if (groupId) {
      let prospectId: number | null = null;
      const insertId = Number((result as any).insertId || 0);
      if (insertId > 0) {
        prospectId = insertId;
      } else {
        const [rows] = await connection.query(
          'SELECT id FROM affiliate_prospects WHERE user_id = ? AND tiktok_username = ? LIMIT 1',
          [userId, username]
        );
        prospectId = Number((rows as any[])[0]?.id || 0) || null;
      }

      if (prospectId) {
        await connection.query(
          `INSERT INTO affiliate_group_assignments (user_id, group_id, prospect_id, assigned_account_id)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE assigned_account_id = assigned_account_id`,
          [userId, groupId, prospectId, accountId]
        );
      }
    }
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

async function addProspectEdsByUsername(userId: number, username: string, points: number): Promise<void> {
  if (!points) return;
  const connection = await db.getConnection();
  try {
    await connection.query(
      `UPDATE affiliate_prospects
       SET engagement_depth_score = engagement_depth_score + ?,
           last_interaction_at = NOW()
       WHERE user_id = ? AND tiktok_username = ?`,
      [points, userId, username]
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

function getSnoozeDaysForProspect(prospect: ProspectRow | null, config: AffiliateConfig): number {
  if (prospect && asBool(prospect.is_keep_in_touch)) {
    return config.keepInTouchSnoozeDays;
  }
  return config.snoozeDays;
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
    const beforeState = await page.evaluate(() => {
      const level1 = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
      const item = document.querySelectorAll('[data-e2e="comment-item"]').length;
      const generic = document.querySelectorAll('div[class*="CommentItem"], div[class*="comment-item"]').length;
      return {
        level1,
        item,
        generic,
        total: Math.max(level1, item, generic)
      };
    });
    if (beforeState.total > 0) {
      console.log('[Affiliate Worker] Comments appear already open:', beforeState);
      return;
    }

    const clickAttempt = await page.evaluate(() => {
      const icon = document.querySelector('[data-e2e="comment-icon"]');
      const iconButton = icon?.closest('button') as HTMLButtonElement | null;
      const explicitButtons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
      const textButton = explicitButtons.find((btn) => {
        const text = (btn.textContent || '').trim().toLowerCase();
        return text === 'comments' || text === 'comment';
      });

      const target = iconButton || textButton;
      if (!target) {
        return { clicked: false, hadIcon: Boolean(icon), foundTextButton: Boolean(textButton) };
      }

      target.click();
      return { clicked: true, hadIcon: Boolean(icon), foundTextButton: Boolean(textButton) };
    });
    console.log('[Affiliate Worker] Comment panel click attempt:', clickAttempt);

    await delay(1500);

    const afterState = await page.evaluate(() => {
      const level1 = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
      const item = document.querySelectorAll('[data-e2e="comment-item"]').length;
      const generic = document.querySelectorAll('div[class*="CommentItem"], div[class*="comment-item"]').length;
      return {
        level1,
        item,
        generic,
        total: Math.max(level1, item, generic)
      };
    });
    console.log('[Affiliate Worker] Comments state after opening panel:', afterState);
  } catch (error) {
    console.log('[Affiliate] ⚠️ openCommentsPanel error:', error);
  }
}

async function expandAllCommentReplies(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const clicked = await page.evaluate(() => {
      const textCandidates = Array.from(document.querySelectorAll('button, span, div')) as HTMLElement[];
      const target = textCandidates.find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return /^view\s+\d+\s+repl(y|ies)$/.test(text);
      });

      if (!target) return false;
      target.click();
      return true;
    });

    if (!clicked) {
      break;
    }

    await delay(350);
  }
}

async function loadAllCommentsForVideo(page: Page): Promise<void> {
  try {
    const scrollInfo = await page.evaluate(() => {
      const commentsCountEl =
        document.querySelector('[class*="DivCommentCountContainer"]') ||
        document.querySelector('[data-e2e="comment-count"]') ||
        document.querySelector('[data-e2e="browse-comment-count"]');

      const totalComments = parseInt(commentsCountEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);

      const containers = Array.from(
        document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]')
      ) as HTMLElement[];

      const container = containers.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 150 && rect.height > 150;
      }) as HTMLElement | undefined;

      if (!container) {
        return { found: false, totalComments, visibleContainers: containers.length };
      }

      const rect = container.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const x = rect.left + rect.width / 2;
      const y = Math.min(rect.top + 200, viewportHeight * 0.6);

      const level1Count = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
      const itemCount = document.querySelectorAll('[data-e2e="comment-item"]').length;
      const genericCount = document.querySelectorAll('div[class*="CommentItem"], div[class*="comment-item"]').length;

      return {
        found: true,
        totalComments,
        x,
        y,
        level1Count,
        itemCount,
        genericCount,
        containerTag: container.tagName,
        containerClass: container.className,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight
      };
    });

    console.log('[Affiliate Worker] Comment scroll init:', {
      found: scrollInfo.found,
      totalComments: scrollInfo.totalComments,
      visibleContainers: scrollInfo.visibleContainers,
      level1Count: scrollInfo.level1Count,
      itemCount: scrollInfo.itemCount,
      genericCount: scrollInfo.genericCount,
      containerTag: scrollInfo.containerTag,
      containerClass: scrollInfo.containerClass,
      scrollTop: scrollInfo.scrollTop,
      scrollHeight: scrollInfo.scrollHeight,
      clientHeight: scrollInfo.clientHeight
    });

    const mouseX = Number(scrollInfo.x);
    const mouseY = Number(scrollInfo.y);
    if (!scrollInfo.found || !Number.isFinite(mouseX) || !Number.isFinite(mouseY)) {
      console.log('[Affiliate Worker] No suitable comment scroll container found; skipping deep scroll');
      return;
    }

    await page.mouse.move(mouseX, mouseY);
    await delay(1200);

    let loadedComments = await page.evaluate(() => {
      const level1 = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
      const item = document.querySelectorAll('[data-e2e="comment-item"]').length;
      const generic = document.querySelectorAll('div[class*="CommentItem"], div[class*="comment-item"]').length;
      return Math.max(level1, item, generic);
    });
    let attempts = 0;
    let noGrowth = 0;
    let bottomStalls = 0;
    const maxAttempts = 120;
    const target = scrollInfo.totalComments > 0 ? Math.max(scrollInfo.totalComments, loadedComments) : Number.POSITIVE_INFINITY;
    console.log(`[Affiliate Worker] Comment scroll target: ${Number.isFinite(target) ? target : 'unknown/infinite'} (starting at ${loadedComments})`);

    while (attempts < maxAttempts) {
      attempts += 1;
      const before = loadedComments;

      await page.mouse.wheel({ deltaY: 800 });
      await delay(2000);

      const stateAfterScroll = await page.evaluate(() => {
        const level1 = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
        const item = document.querySelectorAll('[data-e2e="comment-item"]').length;
        const generic = document.querySelectorAll('div[class*="CommentItem"], div[class*="comment-item"]').length;
        const containers = Array.from(
          document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]')
        ) as HTMLElement[];
        const container = containers.find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 150 && rect.height > 150;
        }) as HTMLElement | undefined;

        return {
          loadedComments: Math.max(level1, item, generic),
          level1,
          item,
          generic,
          scrollTop: container?.scrollTop ?? null,
          maxScrollTop:
            container && Number.isFinite(container.scrollHeight - container.clientHeight)
              ? container.scrollHeight - container.clientHeight
              : null,
          scrollHeight: container?.scrollHeight ?? null,
          clientHeight: container?.clientHeight ?? null
        };
      });

      loadedComments = stateAfterScroll.loadedComments;

      console.log(
        `[Affiliate Worker] Scroll attempt ${attempts}: comments ${before} -> ${loadedComments} (level1=${stateAfterScroll.level1}, item=${stateAfterScroll.item}, generic=${stateAfterScroll.generic}, scrollTop=${stateAfterScroll.scrollTop}, scrollHeight=${stateAfterScroll.scrollHeight}, clientHeight=${stateAfterScroll.clientHeight})`
      );

      const atBottom =
        stateAfterScroll.scrollTop !== null &&
        stateAfterScroll.maxScrollTop !== null &&
        stateAfterScroll.scrollTop >= stateAfterScroll.maxScrollTop - 2;

      if (loadedComments > before) {
        noGrowth = 0;
        bottomStalls = 0;
      } else {
        noGrowth += 1;

        if (atBottom) {
          bottomStalls += 1;

          // Nudge up and back down to trigger next virtualized page load.
          await page.evaluate(() => {
            const containers = Array.from(
              document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]')
            ) as HTMLElement[];
            const container = containers.find((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 150 && rect.height > 150;
            }) as HTMLElement | undefined;

            if (!container) return;
            container.scrollTop = Math.max(0, container.scrollTop - Math.max(220, Math.floor(container.clientHeight * 0.35)));
          });
          await delay(700);

          await page.evaluate(() => {
            const containers = Array.from(
              document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]')
            ) as HTMLElement[];
            const container = containers.find((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 150 && rect.height > 150;
            }) as HTMLElement | undefined;

            if (!container) return;
            container.scrollTop = Math.min(
              container.scrollHeight,
              container.scrollTop + Math.max(420, Math.floor(container.clientHeight * 0.75))
            );
          });
          await delay(900);
        }

        if (noGrowth >= 10 && bottomStalls >= 4) {
          console.log('[Affiliate Worker] Stopping comment scroll: virtualized list appears exhausted (no growth with repeated bottom stalls)');
          break;
        }
      }

      if (scrollInfo.totalComments > 0 && loadedComments >= scrollInfo.totalComments) {
        console.log('[Affiliate Worker] Reached expected comment count based on UI comment counter');
        break;
      }
    }

    console.log(`[Affiliate Worker] Comment scrolling complete after ${attempts} attempts; loadedComments=${loadedComments}`);
  } catch (error) {
    console.log('[Affiliate Worker] Comment scrolling failed, continuing with currently loaded comments:', error);
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

async function scrapeVideoCommentsDetailed(page: Page, maxComments = 60): Promise<ScrapedComment[]> {
  console.log(`[Affiliate Worker] scrapeVideoCommentsDetailed() starting (maxComments=${maxComments})`);
  const result = await page.evaluate((max: number) => {
    const commentSelectors = [
      '[data-e2e="comment-item"]',
      '[data-e2e="comment-level-1"]',
      'div[class*="CommentItem"]',
      'div[class*="comment-item"]',
      '[data-e2e="comment-list"] > div',
      'div[class*="Comment"]'
    ];

    let commentElements: any[] = [];
    let selectorUsed = '';
    for (const selector of commentSelectors) {
      commentElements = Array.from(document.querySelectorAll(selector));
      if (commentElements.length > 0) {
        selectorUsed = selector;
        break;
      }
    }

    const sampleDataE2E = Array.from(document.querySelectorAll('[data-e2e]'))
      .slice(0, 40)
      .map((el: any) => el.getAttribute('data-e2e'))
      .filter((value): value is string => Boolean(value));

    const timeDiagnostics = commentElements.slice(0, Math.min(max, 10)).map((el: any, index: number) => {
      const wrapper =
        el.closest('[class*="DivCommentItemWrapper"]') ||
        el.closest('[data-e2e="comment-item"]') ||
        el;

      const spanTexts = Array.from(wrapper?.querySelectorAll?.('span') || [])
        .map((span: any) => (span.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 12);

      const matchingTimeTexts = spanTexts.filter((text: string) => {
        return (
          /\d+[smhdw]\s*ago/i.test(text) ||
          /^(yesterday|just now)$/i.test(text) ||
          /^\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)\b/i.test(text) ||
          /^\d{1,2}-\d{1,2}$/.test(text) ||
          /^\d{4}-\d{1,2}-\d{1,2}$/.test(text) ||
          /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i.test(text)
        );
      });

      return {
        index: index + 1,
        wrapperTag: wrapper?.tagName || null,
        wrapperDataE2E: wrapper?.getAttribute?.('data-e2e') || null,
        wrapperClass: String(wrapper?.className || '').slice(0, 140),
        matchingTimeTexts,
        spanSample: spanTexts.slice(0, 6),
        textSample: String((el as any)?.innerText || (el as any)?.textContent || '').slice(0, 140)
      };
    });

    const comments = commentElements.map((el: any) => {
      try {
        const wrapper =
          el.closest('[class*="DivCommentItemWrapper"]') ||
          el.closest('[class*="DivContentContainer"]') ||
          el.closest('[data-e2e="comment-item"]') ||
          el.parentElement ||
          el;

        // Username: Extract actual username from href, not display name (which may have emojis)
        const usernameContainer =
          wrapper.querySelector('[data-e2e^="comment-username"]') ||
          wrapper;
        const usernameLink =
          (wrapper.querySelector('a[href*="/@"]') as any) ||
          usernameContainer?.querySelector('a');

        let commentUsername = '';
        if (usernameLink) {
          // Extract username from href like "/@username" or "/user/username"
          const href = usernameLink.getAttribute('href');
          if (href) {
            const match = href.match(/\/@([^/?]+)/); // Match /@username
            if (match) {
              commentUsername = match[1]; // Get username without @
            }
          }
        }

        // Fallback to text content if href extraction failed
        if (!commentUsername) {
          commentUsername =
            usernameContainer?.textContent?.trim().replace('@', '') ||
            (usernameContainer?.querySelector('a p') || usernameContainer?.querySelector('p'))?.textContent?.trim().replace('@', '') ||
            '';
        }

        // Comment text: it's a child span of the comment-level-1 element
        const commentText =
          (wrapper.querySelector('[data-e2e="comment-level-1"]') as any)?.textContent?.trim() ||
          (wrapper.querySelector('[data-e2e="comment-text"]') as any)?.textContent?.trim() ||
          (wrapper.querySelector('span.TUXText') as any)?.textContent?.trim() ||
          (el.querySelector('span.TUXText') as any)?.textContent?.trim() ||
          (el.querySelector('span') as any)?.textContent?.trim() ||
          '';

        // Likes: look in the parent comment wrapper
        const likeContainer = wrapper.querySelector('[class*="DivLikeContainer"]');
        const commentLikes = parseInt((likeContainer?.querySelector('span'))?.textContent?.replace(/[^0-9]/g, '') || '0', 10);

        // Time: look for all span elements and find the one with time text
        // TikTok formats: "5d ago", "2h ago", "Yesterday", "Just now", "12-22", "2024-01-15", "Jan 18"
        const allSpans = Array.from(wrapper?.querySelectorAll('span') || []);

        const directTime =
          (wrapper.querySelector('[data-e2e^="comment-time"]') as any)?.textContent?.trim() ||
          (wrapper.querySelector('[data-e2e="comment-time-1"]') as any)?.textContent?.trim() ||
          '';

        let relativeTime = '';
        if (directTime) {
          relativeTime = directTime;
        }
        for (const span of allSpans) {
          if (relativeTime) break;
          const text = span.textContent?.trim() || '';
          // Check if this span contains a time pattern
          if (
            /\d+[smhdw]\s*ago/i.test(text) ||           // "5d ago", "2h ago"
            /^(yesterday|just now)$/i.test(text) ||      // "Yesterday", "Just now"
            /^\d{1,2}-\d{1,2}$/.test(text) ||            // "12-22", "1-5"
            /^\d{4}-\d{1,2}-\d{1,2}$/.test(text) ||      // "2024-01-15"
            /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i.test(text) // "Jan 18"
          ) {
            relativeTime = text;
            break;
          }
        }

        return {
          username: commentUsername,
          text: commentText,
          likes: commentLikes,
          relativeTime,
          profileUrl: commentUsername ? `https://www.tiktok.com/@${commentUsername}` : ''
        };
      } catch (err) {
        return null;
      }
    }).filter((c: any) => c && c.username && c.text);

    return {
      selectorUsed,
      commentElementCount: commentElements.length,
      sampleDataE2E,
      timeDiagnostics,
      comments
    };
  }, maxComments);

  console.log(
    `[Affiliate Worker] Comment extraction selector: ${result.selectorUsed || 'NONE'} | elements: ${result.commentElementCount} | extracted: ${result.comments.length}`
  );
  if (result.timeDiagnostics?.length) {
    console.log('[Affiliate Worker] Pre-extraction time diagnostics:', result.timeDiagnostics);
  }
  if (!result.commentElementCount) {
    console.log('[Affiliate Worker] No comment elements found. Sample page data-e2e:', result.sampleDataE2E.slice(0, 20));
  }

  return result.comments;
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

async function waitForProfileMetaToLoad(page: Page): Promise<void> {
  await delay(2000);

  try {
    await page.waitForSelector('[data-e2e="followers-count"], strong[title="Followers"]', {
      timeout: 30000,
      visible: true
    });

    await page.waitForFunction(
      () => {
        const followersEl =
          (document.querySelector('[data-e2e="followers-count"]') as HTMLElement | null) ||
          (document.querySelector('strong[title="Followers"]') as HTMLElement | null);

        return Boolean(followersEl?.innerText?.trim());
      },
      { timeout: 10000 }
    );

    await delay(750);
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const followersByDataE2E = document.querySelector('[data-e2e="followers-count"]') as HTMLElement | null;
      const followersByTitle = document.querySelector('strong[title="Followers"]') as HTMLElement | null;
      const statCandidates = Array.from(document.querySelectorAll('[data-e2e], strong[title]'))
        .map((el) => ({
          tag: el.tagName,
          dataE2E: el.getAttribute('data-e2e'),
          title: el.getAttribute('title'),
          text: (el.textContent || '').trim().slice(0, 40)
        }))
        .filter((entry) => {
          const dataE2E = String(entry.dataE2E || '');
          const title = String(entry.title || '');
          return dataE2E.includes('count') || title === 'Followers';
        })
        .slice(0, 12);

      return {
        url: window.location.href,
        followersByDataE2EText: followersByDataE2E?.innerText?.trim() || '',
        followersByTitleText: followersByTitle?.innerText?.trim() || '',
        statCandidates
      };
    });

    console.log('[Affiliate Worker] Profile meta wait timed out before follower scrape:', {
      error: error instanceof Error ? error.message : String(error),
      diagnostics
    });
  }
}

async function scrapeProfileMeta(page: Page): Promise<{ userTitle: string; bioText: string; followerCount: number | null }> {
  return page.evaluate(() => {
    const title =
      (document.querySelector('[data-e2e="user-title"]') as HTMLElement | null)?.innerText?.trim() ||
      (document.querySelector('h1[data-e2e="user-title"]') as HTMLElement | null)?.innerText?.trim() ||
      '';

    const bio =
      (document.querySelector('[data-e2e="user-bio"]') as HTMLElement | null)?.innerText?.trim() ||
      (document.querySelector('[data-e2e="user-bio-description"]') as HTMLElement | null)?.innerText?.trim() ||
      '';

    const followersRaw =
      (document.querySelector('[data-e2e="followers-count"]') as HTMLElement | null)?.innerText?.trim() ||
      (document.querySelector('strong[title="Followers"]') as HTMLElement | null)?.innerText?.trim() ||
      '';

    return { userTitle: title, bioText: bio, followerCountRaw: followersRaw };
  }).then((meta: any) => ({
    userTitle: meta.userTitle || '',
    bioText: meta.bioText || '',
    followerCount: parseFollowerCount(meta.followerCountRaw)
  }));
}

async function upsertProspectWithType(
  userId: number,
  username: string,
  profileUrl: string,
  prospectType: ProspectType
): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO affiliate_prospects (user_id, tiktok_username, profile_url, prospect_type)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         profile_url = VALUES(profile_url),
         prospect_type = VALUES(prospect_type)`,
      [userId, username, profileUrl, prospectType]
    );
  } finally {
    connection.release();
  }
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
  const collectedUrls = new Set<string>();

  const collectSearchUrls = async (): Promise<string[]> => {
    return page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-e2e="search_top-item"], [data-e2e="feed-video"]'));
      const cardUrls = cards
        .map(card => {
          const link = card.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
          return link?.getAttribute('href') || '';
        })
        .filter(Boolean);

      if (cardUrls.length > 0) {
        return cardUrls;
      }

      const fallback = Array.from(document.querySelectorAll('a[href*="/video/"]')) as HTMLAnchorElement[];
      return fallback
        .map(link => link.getAttribute('href') || '')
        .filter(Boolean);
    });
  };

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

  // Smart scrolling: use mouse wheel and verify content loading
  try {
    const scrollInfo = await page.evaluate(() => {
      // Count initial videos
      const initialItems = document.querySelectorAll('[data-e2e="search_top-item"]');
      const initialCount = initialItems.length;

      // Find scrollable container
      const containers = Array.from(document.querySelectorAll('[data-e2e="search_top-item-list"], [class*="DivItemContainer"], main, [role="main"]'));

      const container = containers.find(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 300 && rect.height > 300;
      }) as HTMLElement | undefined;

      if (container) {
        const rect = container.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        return {
          found: true,
          x,
          y,
          initialCount,
          containerTag: container.tagName
        };
      }

      return { found: false, initialCount };
    });

    console.log(`[Affiliate Worker] Initial videos loaded: ${scrollInfo.initialCount}`);

    for (const url of await collectSearchUrls()) {
      collectedUrls.add(normalizeTikTokUrl(url));
    }

    if (scrollInfo.found) {
      console.log(`[Affiliate Worker] Scrollable container found: <${scrollInfo.containerTag}>`);

      // Position mouse over search results container
      await page.mouse.move(scrollInfo.x, scrollInfo.y);
      await delay(1500);

      let loadedVideos = scrollInfo.initialCount;
      let scrollAttempts = 0;
      const maxScrollAttempts = 100;
      const uniqueUrls = new Set<string>();
      let noNewUrlCount = 0;

      for (const url of await collectSearchUrls()) {
        uniqueUrls.add(normalizeTikTokUrl(url));
      }
      for (const url of uniqueUrls) {
        collectedUrls.add(url);
      }

      while (scrollAttempts < maxScrollAttempts) {
        scrollAttempts++;
        const beforeUniqueCount = uniqueUrls.size;

        // Use mouse wheel scroll (triggers TikTok's lazy loading)
        await page.mouse.wheel({ deltaY: 800 });

        // Wait for TikTok's lazy loading
        await delay(2500);

        // Collect any newly rendered URLs before TikTok virtualizes them away
        const currentUrls = await collectSearchUrls();
        for (const url of currentUrls) {
          const normalizedUrl = normalizeTikTokUrl(url);
          uniqueUrls.add(normalizedUrl);
          collectedUrls.add(normalizedUrl);
        }

        // Count videos after scroll
        loadedVideos = await page.evaluate(() => {
          return document.querySelectorAll('[data-e2e="search_top-item"]').length;
        });

        const increased = uniqueUrls.size > beforeUniqueCount;

        // Log progress
        if (scrollAttempts % 5 === 0 || increased || scrollAttempts <= 3) {
          console.log(`[Affiliate Worker] Scroll ${scrollAttempts}: ${beforeUniqueCount} → ${uniqueUrls.size} unique URLs, ${loadedVideos} visible videos ${increased ? '✅' : '⚠️'}`);
        }

        // Stop if no new unique URLs after repeated attempts
        if (!increased) {
          noNewUrlCount++;
          if (noNewUrlCount >= 10) {
            console.log(`[Affiliate Worker] No new URLs after ${noNewUrlCount} scroll attempts - stopping at ${uniqueUrls.size} unique videos (all available)`);
            break;
          }
        } else {
          noNewUrlCount = 0;
        }
      }

      if (scrollAttempts >= maxScrollAttempts) {
        console.log(`[Affiliate Worker] Reached max scroll attempts (${maxScrollAttempts}), proceeding with ${uniqueUrls.size} unique videos`);
      }

      console.log(`[Affiliate Worker] Scrolling complete: collected ${uniqueUrls.size} unique videos in ${scrollAttempts} scroll attempts`);
    } else {
      console.log(`[Affiliate Worker] Could not find scrollable container, proceeding with initially loaded videos`);
    }
  } catch (scrollErr) {
    console.log(`[Affiliate Worker] Error during scroll:`, scrollErr);
  }

  const rawUrls: string[] = collectedUrls.size > 0 ? Array.from(collectedUrls) : await collectSearchUrls();

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

async function openProfileVideoByClick(page: Page, targetVideoUrl: string): Promise<boolean> {
  const normalizedTarget = normalizeTikTokUrl(targetVideoUrl).toLowerCase();
  const targetVideoId = normalizedTarget.match(/\/video\/(\d+)/)?.[1] || '';

  for (let scrollAttempt = 0; scrollAttempt < 8; scrollAttempt++) {
    const links = await page.$$('a[href*="/video/"]');

    for (const link of links) {
      const href = await link.evaluate(el => {
        const anchor = el as HTMLAnchorElement;
        return anchor.href || anchor.getAttribute('href') || '';
      });

      const normalizedHref = normalizeTikTokUrl(href).toLowerCase();
      const hrefVideoId = normalizedHref.match(/\/video\/(\d+)/)?.[1] || '';

      const isMatch =
        normalizedHref === normalizedTarget ||
        (Boolean(targetVideoId) && hrefVideoId === targetVideoId);

      if (!isMatch) {
        continue;
      }

      await link.evaluate(el => {
        (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      });

      await delay(randomInt(180, 420));

      const box = await link.boundingBox();
      if (!box || box.width < 2 || box.height < 2) {
        continue;
      }

      const clickX = box.x + Math.max(2, Math.min(box.width - 2, box.width / 2 + randomInt(-4, 4)));
      const clickY = box.y + Math.max(2, Math.min(box.height - 2, box.height / 2 + randomInt(-4, 4)));

      await page.mouse.move(clickX, clickY, { steps: randomInt(6, 14) });
      await delay(randomInt(60, 200));
      await page.mouse.click(clickX, clickY, { delay: randomInt(20, 90) });

      try {
        await page.waitForSelector('[data-e2e="browse-video"], [data-e2e="browse-username"], video', { timeout: 12000 });
        return true;
      } catch {
      }
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await delay(900);
  }

  return false;
}

async function seedProspectsFromKeyword(
  page: Page,
  userId: number,
  accountId: number,
  groupId: number | null,
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
    await upsertProspectSeed(userId, candidate.creatorUsername, candidate.profileUrl, accountId, groupId);
    seeded++;
  }

  return seeded;
}

async function watchRandomVideos(page: Page, videoUrls: string[], profileUrl: string): Promise<void> {
  if (!videoUrls.length) return;

  const count = Math.min(videoUrls.length, randomInt(1, 3));
  for (let i = 0; i < count; i++) {
    const url = videoUrls[i];
    const opened = await openProfileVideoByClick(page, url);
    if (!opened) {
      continue;
    }

    const watchSeconds = randomInt(WATCH_MIN_SECONDS, WATCH_MAX_SECONDS);
    await delay(watchSeconds * 1000);

    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch {
      try {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } catch {
        return;
      }
    }

    await delay(900);
  }
}

async function scrapeInboxItems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-e2e="inbox-list-item"]'));
    const lines: string[] = [];

    for (const row of rows) {
      const content = row.querySelector('[data-e2e="inbox-content"]')?.textContent?.trim() || '';
      const title = row.querySelector('[data-e2e="inbox-title"]')?.textContent?.trim() || '';

      let username = '';
      const anchors = Array.from(row.querySelectorAll('a[href*="/@"]')) as HTMLAnchorElement[];
      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(/\/@([^/?#]+)/);
        if (match?.[1]) {
          username = match[1];
          break;
        }
      }

      const combined = `${username} ${title} ${content}`.trim();
      if (combined) lines.push(combined);
    }

    return lines;
  });
}

async function processNotificationsAndScore(
  page: Page,
  userId: number
): Promise<void> {
  try {
    const activityButtonSelector = [
      '[data-e2e="nav-activity"]',
      'button[aria-label="Activity"]',
      '[role="listitem"][aria-label="Activity"]'
    ].join(', ');

    try {
      await page.waitForSelector(activityButtonSelector, { timeout: 15000, visible: true });
    } catch {
      console.log('[Affiliate Worker] Notification check skipped: Activity button did not render in time');
      return;
    }

    try {
      await page.click(activityButtonSelector);
      console.log('[Affiliate Worker] Opened Activity notifications');
    } catch (error) {
      console.log('[Affiliate Worker] Notification check skipped: failed to click Activity button', error);
      return;
    }

    try {
      await page.waitForFunction(
        () => {
          const inboxList = document.querySelector('[data-e2e="inbox-list"]');
          const inboxListById = document.querySelector('#header-inbox-list');
          const inboxItems = document.querySelectorAll('[data-e2e="inbox-list-item"]');
          return Boolean(inboxList || inboxListById || inboxItems.length > 0);
        },
        { timeout: 15000 }
      );

      await page.waitForSelector('[data-e2e="inbox-list-item"], [data-e2e="inbox-list"], #header-inbox-list', {
        timeout: 15000
      });
    } catch {
      console.log('[Affiliate Worker] Notification check skipped: inbox list did not appear after clicking Activity');
      return;
    }

    await delay(1200);

    // Click any visible "Follow back" buttons in the notification panel before scraping
    let followBackClicked = 0;
    for (let pass = 0; pass < 8; pass++) {
      const clickedAny = await page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll('[data-e2e="follow-back"]')
        ) as HTMLButtonElement[];
        const visible = btns.filter((btn) => {
          const rect = btn.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= 0 &&
            rect.bottom <= window.innerHeight &&
            !btn.disabled
          );
        });
        if (!visible.length) return false;
        visible.forEach((btn) => btn.click());
        return visible.length;
      });

      if (clickedAny) {
        followBackClicked += Number(clickedAny);
        console.log(`[Affiliate Worker] Clicked ${clickedAny} Follow-back button(s) (pass ${pass + 1})`);
        await delay(600);
      }

      // Scroll the panel to reveal more items
      await page.evaluate(() => {
        const panel =
          (document.querySelector('[data-e2e="inbox-list"]') as HTMLElement | null) ||
          (document.querySelector('#header-inbox-list') as HTMLElement | null);
        if (panel) panel.scrollBy({ top: 600, left: 0, behavior: 'auto' });
      });
      await page.mouse.wheel({ deltaY: 600 });
      await delay(500);

      // Stop early if no more buttons found after two empty passes
      const hasMore = await page.evaluate(() => {
        return document.querySelectorAll('[data-e2e="follow-back"]').length > 0;
      });
      if (!hasMore && pass >= 1) break;
    }

    if (followBackClicked > 0) {
      console.log(`[Affiliate Worker] ✅ Followed back ${followBackClicked} user(s) from notification panel`);
    } else {
      console.log('[Affiliate Worker] No Follow-back buttons found in notification panel');
    }

    const collected = new Set<string>();
    let noGrowthRounds = 0;

    for (let i = 0; i < 12 && collected.size < 30; i++) {
      const batch = await scrapeInboxItems(page);
      const before = collected.size;
      for (const line of batch) {
        collected.add(line);
      }

      if (collected.size === before) {
        noGrowthRounds += 1;
      } else {
        noGrowthRounds = 0;
      }

      if (collected.size >= 30 || noGrowthRounds >= 3) {
        break;
      }

      await page.mouse.move(150, 300);
      await page.mouse.wheel({ deltaY: 650 });

      await page.evaluate(() => {
        const panel = document.querySelector('[data-e2e="inbox-list"]') as HTMLElement | null;
        if (panel) {
          panel.scrollBy({ top: 650, left: 0, behavior: 'auto' });
        }
      });

      await delay(700);
    }

    const activityText = Array.from(collected).slice(0, 30);
    console.log(`[Affiliate Worker] Scraped ${activityText.length} inbox notifications for scoring`);

    if (!activityText.length) {
      return;
    }

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

async function selectTier1Prospect(
  userId: number,
  accountId: number,
  groupId: number | null
): Promise<Tier1SelectionResult> {
  const prospects = await getProspectsOrdered(userId);
  if (!prospects.length) {
    return {
      prospect: null,
      allReachableProspectsSnoozed: false,
      reachableProspectCount: 0
    };
  }

  const now = new Date();
  const assignmentMap = await getGroupAssignmentMap(userId, groupId);

  const reachableProspects = prospects.filter((prospect) => {
    if (asBool(prospect.is_ignore_list)) {
      return false;
    }

    if (groupId) {
      const assignedAccountId = assignmentMap.get(prospect.id);
      if (assignedAccountId && assignedAccountId !== accountId) {
        return false;
      }
      return true;
    }

    if (prospect.incogniton_account_id && prospect.incogniton_account_id !== accountId) {
      return false;
    }

    return true;
  });

  const allReachableProspectsSnoozed =
    reachableProspects.length > 0 &&
    reachableProspects.every((prospect) => prospect.snoozed_until && new Date(prospect.snoozed_until) > now);

  const candidates = reachableProspects.filter((prospect) => {
    if (prospect.snoozed_until && new Date(prospect.snoozed_until) > now) {
      return false;
    }

    if (prospect.prospect_type === 'status_unknown' || prospect.prospect_type === 'disqualified') {
      return false;
    }

    return true;
  });

  if (!candidates.length) {
    return {
      prospect: null,
      allReachableProspectsSnoozed,
      reachableProspectCount: reachableProspects.length
    };
  }

  let selectedProspect = candidates[0];
  const lastProcessedProspectId = await getGroupLastProcessedProspectId(userId, groupId);
  if (lastProcessedProspectId) {
    const idx = candidates.findIndex((prospect) => prospect.id === lastProcessedProspectId);
    if (idx >= 0) {
      selectedProspect = candidates[(idx + 1) % candidates.length];
    }
  }

  return {
    prospect: selectedProspect,
    allReachableProspectsSnoozed,
    reachableProspectCount: reachableProspects.length
  };
}

async function processProspect(
  page: Page,
  userId: number,
  account: AccountWithGroup,
  config: AffiliateConfig,
  groupConfig: GroupPromptConfig,
  prospectInput: ProspectRow
): Promise<boolean> {
  let prospect = prospectInput;

  if (account.group_id) {
    const assignment = await ensureGroupProspectAssignment(userId, account.group_id, prospect.id, account.id);
    if (assignment === 'assigned_other_account') {
      return false;
    }
  }

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

  if (!asBool(prospect.bio_scraped) || prospect.follower_count === null || !prospect.prospect_type) {
    await waitForProfileMetaToLoad(page);
    const profileData = await scrapeProfileMeta(page);
    const inferredType: ProspectType =
      profileData.followerCount !== null && profileData.followerCount >= config.minAffiliateFollowers
        ? 'prospective_affiliate'
        : 'prospective_customer';

    await updateProspectClassification(prospect.id, {
      userTitle: profileData.userTitle || null,
      bioText: profileData.bioText || null,
      followerCount: profileData.followerCount,
      prospectType: prospect.prospect_type || inferredType
    });

    prospect = (await getProspectById(prospect.id)) || prospect;
  }

  if (prospect.prospect_type === 'disqualified') {
    await snoozeProspect(prospect.id, getSnoozeDaysForProspect(prospect, config));
    return true;
  }

  if (prospect.prospect_type === 'status_unknown') {
    return false;
  }

  await markProspectVisited(prospect.id);

  const profileVideoUrls = await getProfileVideoUrlsForCreator(page, canonicalUsername);
  if (!profileVideoUrls.length) {
    await snoozeProspect(prospect.id, getSnoozeDaysForProspect(prospect, config));
    return true;
  }

  await watchRandomVideos(page, profileVideoUrls, profileUrl);

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch {
    return true;
  }

  const refreshedVideoUrls = await getProfileVideoUrlsForCreator(page, canonicalUsername);
  if (!refreshedVideoUrls.length) {
    await snoozeProspect(prospect.id, getSnoozeDaysForProspect(prospect, config));
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
    await snoozeProspect(prospect.id, getSnoozeDaysForProspect(prospect, config));
    return true;
  }

  const openedTargetVideo = await openProfileVideoByClick(page, targetVideoUrl);
  if (!openedTargetVideo) {
    return true;
  }

  let liked = false;
  let commentPosted = false;
  let caption = '';
  let comments: string[] = [];

  // Keep the probability check structure in place so randomized commenting can be restored later.
  if (Math.random() < 1) {
    await openCommentsPanel(page);
    await delay(1200);
    await expandAllCommentReplies(page);
    await loadAllCommentsForVideo(page);

    const preScrapeCounts = await page.evaluate(() => {
      const level1 = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
      const item = document.querySelectorAll('[data-e2e="comment-item"]').length;
      const generic = document.querySelectorAll('div[class*="CommentItem"], div[class*="comment-item"]').length;
      return { level1, item, generic };
    });
    console.log('[Affiliate Worker] Pre-scrape comment element counts:', preScrapeCounts);

    const content = await scrapeVideoContent(page, 10);
    const detailedComments = await scrapeVideoCommentsDetailed(page, 400);
    console.log(`[Affiliate Worker] scrapeVideoCommentsDetailed() collected ${detailedComments.length} comments`);
    detailedComments.slice(0, 50).forEach((comment, index) => {
      console.log(
        `[Affiliate Worker] Comment ${index + 1}: @${comment.username} | ${comment.relativeTime} | ${comment.text.substring(0, 120)}`
      );
    });
    caption = content.caption || '';
    comments = content.comments || [];

    if (caption || comments.length) {
      let generatedComment = '';
      try {
        generatedComment = await generateAffiliateComment(
          caption,
          comments,
          groupConfig.brandVoice,
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

    const recentComments = detailedComments.filter((c, index) => {
      const parsedDays = parseRelativeTimeToDays(c.relativeTime);
      const isRecent = parsedDays <= 7;
      console.log(
        `[Affiliate Worker] Time parse ${index + 1}: @${c.username} | raw="${c.relativeTime}" | parsedDays=${Number.isFinite(parsedDays) ? parsedDays.toFixed(3) : 'INF'} | within7Days=${isRecent}`
      );
      return isRecent;
    });
    console.log(
      `[Affiliate Worker] Recent comments within 7 days: ${recentComments.length} / ${detailedComments.length}`
    );
    recentComments.slice(0, 50).forEach((comment, index) => {
      console.log(
        `[Affiliate Worker] Recent ${index + 1}: @${comment.username} | ${comment.relativeTime} | ${comment.text.substring(0, 120)}`
      );
    });
    if (recentComments.length > 0) {
      try {
        console.log(
          `[Affiliate Worker] Sending ${recentComments.length} recent comments to OpenAI for buying intent analysis on ${targetVideoUrl}`
        );
        const buyingIntentResults = await analyzeCommentsForBuyingIntent(recentComments, targetVideoUrl, {
          aiPrompt: groupConfig.aiPrompt,
          exampleDM: groupConfig.exampleDM,
          exampleComment: groupConfig.exampleComment,
          openaiApiKey: config.openaiApiKey
        });

        console.log(`[Affiliate Worker] OpenAI returned ${buyingIntentResults.length} buying-intent results`);

        for (const result of buyingIntentResults) {
          const matched = recentComments.find((c) => c.username.toLowerCase() === String(result.username || '').toLowerCase());
          if (!matched) continue;

          if (result.hasBuyingIntent) {
            await upsertProspectWithType(userId, matched.username, matched.profileUrl, 'prospective_customer');

            const replyText = String(result.customizedReply || '').trim();
            if (replyText) {
              const alreadyContacted = await hasContactedUser(userId, matched.username);
              if (!alreadyContacted) {
                const replyResult = await postCommentReply(page, targetVideoUrl, replyText, matched.username);
                if (replyResult.success) {
                  await recordContact(userId, matched.username, 'comment', account.id, targetVideoUrl);
                  await logActivity(
                    userId,
                    account.id,
                    'comment_posted',
                    matched.username,
                    targetVideoUrl,
                    replyText,
                    true
                  );
                  await addProspectEdsByUsername(userId, matched.username, 1);
                } else {
                  await logActivity(
                    userId,
                    account.id,
                    'comment_posted',
                    matched.username,
                    targetVideoUrl,
                    replyText,
                    false,
                    replyResult.error
                  );
                }
              }
            }
          } else {
            await upsertProspectWithType(userId, matched.username, matched.profileUrl, 'status_unknown');
          }
        }
      } catch (error) {
        console.log('[Affiliate Worker] Buying intent analysis failed:', error);
      }
    }
  }

  liked = await likeVideo(page);
  if (liked) {
    await addProspectEds(prospect.id, 1);
  }

  const latestProspect = await getProspectById(prospect.id);
  const shouldFollow = latestProspect
    ? !asBool(latestProspect.is_following) && (asBool(latestProspect.is_following_us) || Math.random() < 0.05)
    : false;

  if (shouldFollow) {
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

  await snoozeProspect(prospect.id, getSnoozeDaysForProspect(prospect, config));

  const refreshedProspect = await getProspectById(prospect.id);
  const dmSent = refreshedProspect ? asBool(refreshedProspect.dm_sent) : false;
  const currentEds = refreshedProspect?.engagement_depth_score ?? 0;
  const keepInTouch = refreshedProspect ? asBool(refreshedProspect.is_keep_in_touch) : false;

  const isProspectiveAffiliate = refreshedProspect?.prospect_type === 'prospective_affiliate';
  if (
    isProspectiveAffiliate &&
    !keepInTouch &&
    !dmSent &&
    currentEds >= config.dmEdsThreshold &&
    groupConfig.affiliateInvitationText?.trim() &&
    Math.random() < 0.5
  ) {
    const alreadyContacted = await hasContactedUser(userId, canonicalUsername);
    if (!alreadyContacted) {
      const context = await getRecentContextForProspect(userId, canonicalUsername);

      let dmText = groupConfig.affiliateInvitationText;
      try {
        const generatedDm = await generateAffiliateProspectDM(
          canonicalUsername,
          refreshedProspect?.user_title || '',
          refreshedProspect?.bio_text || '',
          context.captions,
          context.comments,
          groupConfig.affiliateDmPrompt || groupConfig.affiliateInvitationText,
          groupConfig.brandVoice,
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

async function processStatusUnknownProspectsForAccount(
  page: Page,
  userId: number,
  config: AffiliateConfig
): Promise<number> {
  const prospects = await getStatusUnknownProspects(userId);
  let processed = 0;

  for (const prospect of prospects) {
    try {
      const profileUrl = prospect.profile_url || `https://www.tiktok.com/@${prospect.tiktok_username}`;
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await waitForProfileMetaToLoad(page);
      const profileMeta = await scrapeProfileMeta(page);
      if (profileMeta.followerCount !== null && profileMeta.followerCount < config.minAffiliateFollowers) {
        await updateProspectClassification(prospect.id, {
          followerCount: profileMeta.followerCount,
          userTitle: profileMeta.userTitle || null,
          bioText: profileMeta.bioText || null,
          prospectType: 'disqualified'
        });
        processed += 1;
        continue;
      }

      const outboundUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href^="http"]')) as HTMLAnchorElement[];
        const picked = links.find((a) => {
          const href = a.getAttribute('href') || '';
          return href.startsWith('http') && !href.includes('tiktok.com');
        });
        return picked?.href || null;
      });

      let scrapedExternalHtml = '';
      if (outboundUrl) {
        try {
          await page.goto(outboundUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          scrapedExternalHtml = await page.content();
          if (scrapedExternalHtml.length > 25000) {
            scrapedExternalHtml = scrapedExternalHtml.slice(0, 25000);
          }
        } catch {
          scrapedExternalHtml = '';
        }

        try {
          await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch {
        }
      }

      const profileVideos = await getProfileVideoUrlsForCreator(page, prospect.tiktok_username);
      if (!profileVideos.length) {
        await updateProspectClassification(prospect.id, { prospectType: 'status_unknown' });
        continue;
      }

      const opened = await openProfileVideoByClick(page, profileVideos[0]);
      if (!opened) {
        continue;
      }

      await openCommentsPanel(page);
      await delay(1000);
      await expandAllCommentReplies(page);

      const video = await scrapeVideoContent(page, 10);
      const classification = await classifyStatusUnknownProspect({
        username: prospect.tiktok_username,
        userTitle: profileMeta.userTitle || '',
        bioText: profileMeta.bioText || '',
        firstVideoCaption: video.caption || '',
        firstVideoComments: (video.comments || []).slice(0, 10),
        externalHtml: scrapedExternalHtml,
        openaiApiKey: config.openaiApiKey
      });

      await updateProspectClassification(prospect.id, {
        followerCount: profileMeta.followerCount,
        userTitle: profileMeta.userTitle || null,
        bioText: profileMeta.bioText || null,
        prospectType: classification.qualifiesAsAffiliate ? 'prospective_affiliate' : 'disqualified'
      });

      processed += 1;
    } catch (error) {
      console.log(`[Affiliate Worker] Status Unknown analysis failed for @${prospect.tiktok_username}:`, error);
    }
  }

  return processed;
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

    const groupConfig = await getGroupPromptConfig(userId, account.group_id);
    if (!groupConfig) {
      sendUserEvent(userId, {
        type: 'error',
        text: `❌ Affiliate: missing Group prompt config for @${account.account_identifier} (${account.group_name || 'unassigned group'})`
      });
      continue;
    }

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
        let tier1Selection = await selectTier1Prospect(userId, account.id, account.group_id);
        let prospect = tier1Selection.prospect;

        if (!prospect && tier1Selection.allReachableProspectsSnoozed) {
          const statusUnknownProcessed = await processStatusUnknownProspectsForAccount(page, userId, config);
          if (statusUnknownProcessed > 0) {
            tier1Selection = await selectTier1Prospect(userId, account.id, account.group_id);
            prospect = tier1Selection.prospect;
          }
        }

        if (!prospect) {
          const existingProspectCount = await getProspectCount(userId);

          if (existingProspectCount === 0) {
            const seeded = await seedProspectsFromKeyword(
              page,
              userId,
              account.id,
              account.group_id,
              config.keywords,
              keywordIndexRef
            );

            if (seeded === 0) {
              await delay(2500);
              break;
            }

            tier1Selection = await selectTier1Prospect(userId, account.id, account.group_id);
            prospect = tier1Selection.prospect;
            if (!prospect) {
              await delay(1000);
              continue;
            }
          } else {
            console.log(`[Affiliate Worker] No eligible prospects for @${account.account_identifier}; skipping keyword seed because ${existingProspectCount} prospects already exist.`);
            sendUserEvent(userId, {
              type: 'info',
              text: `ℹ️ Affiliate: no eligible prospects for @${account.account_identifier}; skipping keyword search because your prospects list is not empty.`
            });
            await delay(1500);
            break;
          }
        }

        const selectedProspectId = prospect.id;
        const processed = await processProspect(page, userId, account, config, groupConfig, prospect);
        if (processed) {
          sessionCount += 1;
          await setGroupLastProcessedProspectId(userId, account.group_id, selectedProspectId);
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
