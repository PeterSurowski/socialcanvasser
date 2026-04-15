/**
 * Affiliate Procurement Worker
 *
 * Algorithm per session (per account, up to 20 users):
 * Phase 1 – DM snoozed-ready prospects assigned to this account
 * Phase 2 – Keyword search to find new prospects:
 *   For each video: like it, scrape caption + top 10 comments,
 *   generate brand-voice comment via OpenAI, post it,
 *   record video, add creator as prospect assigned to this account.
 * Stop after 20 users processed. Rotate account.
 */

import db from '../config/database.js';
import { sendUserEvent } from '../events/broadcaster.js';
import { generateAffiliateComment } from '../services/openai.js';
import { tryToSendDM, hasContactedUser, recordContact, logActivity } from '../services/engagement.js';
import {
  connectBrowserForAccount,
  closeBrowserConnection,
  type BrowserConnection,
  type TikTokAccount
} from '../services/browserManager.js';
import type { Page } from 'puppeteer-core';

const USERS_PER_SESSION = 20;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function isAffiliateAutomationRunning(userId: number): Promise<boolean> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT affiliate_is_running FROM automation_state WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const row = (rows as any[])[0];
    return row ? Boolean(row.affiliate_is_running) : false;
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
  tiktokUsername: string
): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT IGNORE INTO affiliate_interacted_videos (user_id, video_url, tiktok_username)
       VALUES (?, ?, ?)`,
      [userId, videoUrl, tiktokUsername]
    );
  } finally {
    connection.release();
  }
}

async function upsertAffiliateProspect(
  userId: number,
  tiktokUsername: string,
  profileUrl: string,
  accountId: number,
  snoozeDays: number
): Promise<void> {
  const connection = await db.getConnection();
  try {
    const snoozedUntil = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000);
    await connection.query(
      `INSERT INTO affiliate_prospects
         (user_id, tiktok_username, profile_url, incogniton_account_id, snoozed_until)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         incogniton_account_id = COALESCE(incogniton_account_id, VALUES(incogniton_account_id)),
         snoozed_until = COALESCE(snoozed_until, VALUES(snoozed_until))`,
      [userId, tiktokUsername, profileUrl, accountId, snoozedUntil]
    );
  } finally {
    connection.release();
  }
}

async function getSnoozeReadyProspects(userId: number, accountId: number): Promise<any[]> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT * FROM affiliate_prospects
       WHERE user_id = ? AND incogniton_account_id = ?
         AND dm_sent = FALSE
         AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       ORDER BY created_at ASC`,
      [userId, accountId]
    );
    return rows as any[];
  } finally {
    connection.release();
  }
}

async function markProspectDmSent(prospectId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      'UPDATE affiliate_prospects SET dm_sent = TRUE, dm_sent_at = NOW() WHERE id = ?',
      [prospectId]
    );
  } finally {
    connection.release();
  }
}

async function snoozeProspect(prospectId: number, snoozeDays: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    const snoozedUntil = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000);
    await connection.query(
      'UPDATE affiliate_prospects SET snoozed_until = ? WHERE id = ?',
      [snoozedUntil, prospectId]
    );
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/**
 * Like a video. Returns true if the like button was clicked (or already liked).
 */
async function likeVideo(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      // The like button: find the button that wraps browse-like-count or like-count
      const likeCountEl =
        document.querySelector('[data-e2e="browse-like-count"]') ||
        document.querySelector('[data-e2e="like-count"]');
      if (!likeCountEl) return { success: false, reason: 'like-count element not found' };

      const btn = likeCountEl.closest('button') as HTMLButtonElement | null;
      if (!btn) return { success: false, reason: 'like button not found' };

      // Check aria-pressed to avoid un-liking an already liked video
      if (btn.getAttribute('aria-pressed') === 'true') {
        return { success: true, alreadyLiked: true };
      }

      btn.click();
      return { success: true, alreadyLiked: false };
    });

    if (result.success) {
      console.log(`[Affiliate] 👍 Like: ${result.alreadyLiked ? 'already liked' : 'liked successfully'}`);
      await new Promise(resolve => setTimeout(resolve, 800));
    } else {
      console.log(`[Affiliate] ⚠️ Could not like video: ${result.reason}`);
    }
    return result.success;
  } catch (err) {
    console.log(`[Affiliate] ⚠️ likeVideo error:`, err);
    return false;
  }
}

/**
 * Post a fresh (top-level) comment on the currently open video page.
 * The comments panel must already be open.
 */
async function postFreshComment(
  page: Page,
  commentText: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Click the "Add comment…" placeholder / input area to activate it
    const activated = await page.evaluate(() => {
      const placeholder =
        document.querySelector('[data-e2e="add-comment"]') as HTMLElement | null ||
        document.querySelector('[data-e2e="comment-input-placeholder"]') as HTMLElement | null;
      if (placeholder) {
        placeholder.click();
        return { clicked: true };
      }
      // Fall back to clicking the contenteditable div directly
      const input = document.querySelector('[data-e2e="comment-input"] [contenteditable="true"]') as HTMLElement | null;
      if (input) {
        input.click();
        input.focus();
        return { clicked: true };
      }
      return { clicked: false };
    });

    if (!activated.clicked) {
      console.log(`[Affiliate] ⚠️ Could not activate comment input`);
      // Continue anyway — sometimes the input is already active
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find the active contenteditable input
    const inputSelector = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="comment-input"] [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        '[class*="comment"] [contenteditable="true"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) {
          el.focus();
          return sel;
        }
      }
      return null;
    });

    if (!inputSelector) {
      return { success: false, error: 'Comment input not found' };
    }

    // Type with human-like delay
    await page.type(inputSelector, commentText, { delay: 50 });
    console.log(`[Affiliate] Typed comment: "${commentText.substring(0, 60)}..."`);

    // Wait for Post button to become enabled
    try {
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement | null;
          return btn && !btn.disabled && !btn.hasAttribute('disabled');
        },
        { timeout: 6000 }
      );
    } catch {
      console.log(`[Affiliate] ⚠️ Post button did not enable within 6s`);
      return { success: false, error: 'Post button never enabled' };
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const posted = await page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement | null;
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!posted) {
      return { success: false, error: 'Post button click failed' };
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(`[Affiliate] ✅ Comment posted`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Scrape caption + top N comments from the current video page.
 */
async function scrapeVideoContent(
  page: Page,
  maxComments = 10
): Promise<{ caption: string; comments: string[]; username: string }> {
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
      const urlMatch = window.location.href.match(/@([^/]+)/);
      username = urlMatch ? urlMatch[1] : '';
    }

    const commentEls = Array.from(
      document.querySelectorAll(
        '[data-e2e="comment-level-1"], [data-e2e="comment-item"]'
      )
    ).slice(0, max);

    const comments = commentEls.map(el => {
      const textEl = el.querySelector('span.TUXText') || el.querySelector('span');
      return textEl?.textContent?.trim() || '';
    }).filter(Boolean);

    return { caption, comments, username };
  }, maxComments);
}

/**
 * Open the comments panel on the current video page.
 */
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
    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (err) {
    console.log(`[Affiliate] ⚠️ openCommentsPanel error:`, err);
  }
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

export async function runAffiliateProcurementForAccounts(userId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    // Load config
    const [configRows] = await connection.query(
      `SELECT keywords, brand_voice, affiliate_invitation_text, snooze_days, openai_api_key
       FROM user_config WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    if (!(configRows as any[]).length) {
      console.log('[Affiliate Worker] No config found for user');
      connection.release();
      return;
    }

    const cfg = (configRows as any[])[0];
    const keywords: string[] = (cfg.keywords || '')
      .split(',')
      .map((k: string) => k.trim())
      .filter(Boolean);
    const brandVoice: string = cfg.brand_voice || '';
    const invitationText: string = cfg.affiliate_invitation_text || '';
    const snoozeDays: number = cfg.snooze_days ?? 3;
    const openaiApiKey: string = cfg.openai_api_key || '';

    if (!keywords.length) {
      sendUserEvent(userId, { type: 'error', text: '❌ Affiliate: No keywords configured.' });
      connection.release();
      return;
    }
    if (!openaiApiKey) {
      sendUserEvent(userId, { type: 'error', text: '❌ Affiliate: OpenAI API key not set.' });
      connection.release();
      return;
    }

    // Get available accounts
    const [accountRows] = await connection.query(
      `SELECT id, account_identifier, browser_type, incogniton_profile_id, session_data,
              actions_per_session, current_session_actions, is_rate_limited,
              rate_limit_expires_at, is_paused
       FROM tiktok_accounts
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );

    const accounts = (accountRows as any[]).filter(a => {
      const snoozed =
        a.is_rate_limited &&
        a.rate_limit_expires_at &&
        new Date(a.rate_limit_expires_at) > new Date();
      return !snoozed && !a.is_paused;
    });

    if (!accounts.length) {
      sendUserEvent(userId, {
        type: 'error',
        text: '❌ Affiliate: No available accounts. Check snooze/pause status.'
      });
      connection.release();
      return;
    }

    connection.release();

    // ---------------------------------------------------------------------------
    // Account rotation loop
    // ---------------------------------------------------------------------------
    let keywordIndex = 0;

    for (const account of accounts) {
      if (!(await isAffiliateAutomationRunning(userId))) {
        console.log('[Affiliate Worker] Stopped by user');
        return;
      }

      sendUserEvent(userId, {
        type: 'info',
        text: `🤝 Affiliate: starting session with @${account.account_identifier}`
      });

      let browserConnection: BrowserConnection | null = null;
      let usersProcessed = 0;

      try {
        browserConnection = await connectBrowserForAccount(account as TikTokAccount);
        const page = browserConnection.page;

        // ------------------------------------------------------------------
        // Phase 1: DM prospects that are snooze-ready for this account
        // ------------------------------------------------------------------
        if (invitationText) {
          const prospects = await getSnoozeReadyProspects(userId, account.id);
          console.log(
            `[Affiliate Worker] Phase 1: ${prospects.length} snooze-ready prospects for account ${account.id}`
          );

          for (const prospect of prospects) {
            if (!(await isAffiliateAutomationRunning(userId))) return;
            if (usersProcessed >= USERS_PER_SESSION) break;

            // DM should only go once EVER per TikTok user (use contacted_users table)
            const alreadyContacted = await hasContactedUser(userId, prospect.tiktok_username);
            if (alreadyContacted) {
              await markProspectDmSent(prospect.id);
              continue;
            }

            sendUserEvent(userId, {
              type: 'info',
              text: `📤 Affiliate: sending DM to @${prospect.tiktok_username}`
            });

            const dmResult = await tryToSendDM(page, prospect.tiktok_username, invitationText);
            if (dmResult.success) {
              await recordContact(userId, prospect.tiktok_username, 'dm', account.id, prospect.profile_url);
              await logActivity(
                userId,
                account.id,
                'affiliate_dm_sent',
                prospect.tiktok_username,
                prospect.profile_url,
                invitationText,
                true
              );
              await markProspectDmSent(prospect.id);
              sendUserEvent(userId, {
                type: 'success',
                text: `✅ Affiliate DM sent to @${prospect.tiktok_username}`
              });
            } else {
              console.log(
                `[Affiliate Worker] DM failed for @${prospect.tiktok_username}: ${dmResult.error}`
              );
              // Re-snooze if DM failed so it retries next session
              await snoozeProspect(prospect.id, snoozeDays);
            }

            usersProcessed++;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // ------------------------------------------------------------------
        // Phase 2: Keyword search for new prospects
        // ------------------------------------------------------------------
        const keyword = keywords[keywordIndex % keywords.length];
        keywordIndex++;

        sendUserEvent(userId, {
          type: 'info',
          text: `🔍 Affiliate: searching "${keyword}" with @${account.account_identifier}`
        });

        const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch {
          console.log(`[Affiliate Worker] Navigation timeout for search, continuing anyway...`);
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        // Extract video URLs from search results
        const videoResults: { href: string }[] = await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll('[data-e2e="search_top-item"], [data-e2e="feed-video"]')
          );
          return items
            .slice(0, 50)
            .map(item => {
              const link = item.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
              return { href: link?.getAttribute('href') || '' };
            })
            .filter(r => r.href);
        });

        console.log(
          `[Affiliate Worker] Found ${videoResults.length} videos for keyword "${keyword}"`
        );

        for (const videoEl of videoResults) {
          if (!(await isAffiliateAutomationRunning(userId))) return;
          if (usersProcessed >= USERS_PER_SESSION) break;

          const videoUrl = videoEl.href.startsWith('http')
            ? videoEl.href
            : `https://www.tiktok.com${videoEl.href}`;

          // Skip if already interacted
          if (await hasInteractedWithVideo(userId, videoUrl)) {
            console.log(`[Affiliate Worker] Already interacted with ${videoUrl}, skipping`);
            continue;
          }

          // Navigate to video
          try {
            await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          } catch {
            console.log(`[Affiliate Worker] Navigation timeout for ${videoUrl}, continuing...`);
          }

          try {
            await page.waitForSelector(
              '[data-e2e="browse-video"], [data-e2e="browse-username"], video',
              { timeout: 12000 }
            );
          } catch {
            console.log(`[Affiliate Worker] Video page did not load for ${videoUrl}, skipping`);
            continue;
          }

          await new Promise(resolve => setTimeout(resolve, 1500));

          // Like the video
          await likeVideo(page);

          // Open comments panel
          await openCommentsPanel(page);
          await new Promise(resolve => setTimeout(resolve, 1500));

          // Scrape content
          const content = await scrapeVideoContent(page, 10);
          const creatorUsername = content.username;

          sendUserEvent(userId, {
            type: 'info',
            text: `💬 Affiliate: commenting on @${creatorUsername}'s video`
          });

          // Generate AI comment
          let generatedComment = '';
          try {
            generatedComment = await generateAffiliateComment(
              content.caption,
              content.comments,
              brandVoice,
              openaiApiKey
            );
          } catch (aiErr) {
            console.log(`[Affiliate Worker] OpenAI error:`, aiErr);
            sendUserEvent(userId, {
              type: 'warning',
              text: `⚠️ Affiliate: OpenAI failed for @${creatorUsername}'s video, skipping`
            });
            continue;
          }

          if (!generatedComment) {
            console.log(`[Affiliate Worker] Empty comment generated for ${videoUrl}, skipping`);
            continue;
          }

          // Post the comment
          const commentResult = await postFreshComment(page, generatedComment);
          if (commentResult.success) {
            await logActivity(
              userId,
              account.id,
              'affiliate_comment_posted',
              creatorUsername,
              videoUrl,
              generatedComment,
              true
            );
            sendUserEvent(userId, {
              type: 'success',
              text: `✅ Affiliate comment posted on @${creatorUsername}'s video`
            });
          } else {
            console.log(
              `[Affiliate Worker] Comment post failed for ${videoUrl}: ${commentResult.error}`
            );
            await logActivity(
              userId,
              account.id,
              'affiliate_comment_posted',
              creatorUsername,
              videoUrl,
              generatedComment,
              false,
              commentResult.error
            );
          }

          // Record video as interacted
          await recordInteractedVideo(userId, videoUrl, creatorUsername);

          // Add creator as a prospect (snooze applied so DM goes out next session)
          if (creatorUsername) {
            const profileUrl = `https://www.tiktok.com/@${creatorUsername}`;
            await upsertAffiliateProspect(userId, creatorUsername, profileUrl, account.id, snoozeDays);
          }

          usersProcessed++;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        sendUserEvent(userId, {
          type: 'success',
          text: `✅ Affiliate: @${account.account_identifier} session done (${usersProcessed} users processed)`
        });
      } catch (err) {
        console.error(`[Affiliate Worker] Error on account ${account.id}:`, err);
        sendUserEvent(userId, {
          type: 'error',
          text: `❌ Affiliate error on @${account.account_identifier}: ${err instanceof Error ? err.message : 'Unknown'}`
        });
      } finally {
        if (browserConnection) {
          try {
            await closeBrowserConnection(browserConnection);
          } catch {/* ignore */}
        }
      }
    }

    sendUserEvent(userId, {
      type: 'success',
      text: '✅ Affiliate Procurement: all accounts completed!'
    });
  } catch (err) {
    console.error('[Affiliate Worker] Fatal error:', err);
    if (connection) connection.release();
  }
}

export { setAffiliateRunning, isAffiliateAutomationRunning };
