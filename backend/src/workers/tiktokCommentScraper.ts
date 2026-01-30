import puppeteer from 'puppeteer-core';
import db from '../config/database.js';
import { sendUserEvent } from '../events/broadcaster.js';

interface TikTokComment {
  username: string;
  commentText: string;
  likes: number;
  postedAt: Date | null;
}

/**
 * Scrape comments from a TikTok post
 * Only collects comments from the last 7 days
 */
export async function scrapeCommentsFromPost(
  postId: number,
  videoUrl: string,
  userId: number
): Promise<TikTokComment[]> {
  console.log(`[Comment Scraper] Starting for post ${postId}: ${videoUrl}`);
  
  try {
    // Connect to local Chrome instance
    const browser = await puppeteer.connect({
      browserURL: 'http://localhost:9222',
      defaultViewport: null
    });

    // Get all existing pages and use the first one (should be the TikTok tab from search)
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    console.log(`[Comment Scraper] Using existing page, navigating to video...`);
    
    // Navigate to the video
    await page.goto(videoUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });

    console.log(`[Comment Scraper] Page loaded: ${await page.title()}`);

    // Wait for the video player to load (TikTok uses heavy JavaScript)
    console.log(`[Comment Scraper] Waiting for video player to load...`);
    try {
      await page.waitForSelector('video, [data-e2e="video-player"]', { timeout: 15000 });
      console.log(`[Comment Scraper] Video player found!`);
    } catch (err) {
      console.log(`[Comment Scraper] Video player not found, page might not have loaded properly`);
      return [];
    }

    // Wait for comment section specifically
    console.log(`[Comment Scraper] Waiting for comment section...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if we're on an actual video page
    const hasVideoContent = await page.evaluate(() => {
      return !!(document.querySelector('video') || document.querySelector('[data-e2e="browse-video"]'));
    });
    
    if (!hasVideoContent) {
      console.log(`[Comment Scraper] Not on a video page, TikTok may have blocked access`);
      return [];
    }

    // Scroll to load more comments (TikTok lazy-loads comments)
    console.log(`[Comment Scraper] Scrolling to load comments...`);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const commentSection = document.querySelector('[data-e2e="comment-list"]') || 
                              document.querySelector('[id*="comment"]');
        if (commentSection) {
          commentSection.scrollTop = commentSection.scrollHeight;
        }
      });
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Extract comments from the page
    const comments = await page.evaluate(() => {
      const results: Array<{
        username: string;
        commentText: string;
        likes: number;
        relativeTime: string;
        selectorUsed?: string;
      }> = [];

      // Try multiple selectors for comment containers
      const commentSelectors = [
        '[data-e2e="comment-item"]',
        '[data-e2e="comment-level-1"]',
        'div[class*="CommentItem"]',
        'div[class*="comment-item"]',
        '[data-e2e="comment-list"] > div',
        'div[class*="DivCommentItemContainer"]'
      ];

      let commentElements: Element[] = [];
      let selectorUsed = '';
      for (const selector of commentSelectors) {
        commentElements = Array.from(document.querySelectorAll(selector));
        if (commentElements.length > 0) {
          selectorUsed = selector;
          break;
        }
      }
      
      // Return diagnostic info if no comments found
      if (commentElements.length === 0) {
        return {
          diagnostics: {
            selectorsTried: commentSelectors.length,
            hasCommentList: !!document.querySelector('[data-e2e="comment-list"]'),
            bodyClasses: document.body.className,
            allDataE2E: Array.from(document.querySelectorAll('[data-e2e]')).slice(0, 10).map(el => el.getAttribute('data-e2e'))
          }
        };
      }

      commentElements.forEach(el => {
        try {
          // Extract username
          const usernameEl = el.querySelector('[data-e2e="comment-username"]') ||
                            el.querySelector('a[href^="/@"]') ||
                            el.querySelector('[class*="username"]');
          const username = usernameEl?.textContent?.trim() || '';

          // Extract comment text
          const textEl = el.querySelector('[data-e2e="comment-text"]') ||
                        el.querySelector('[class*="CommentText"]') ||
                        el.querySelector('span[class*="comment-text"]');
          const commentText = textEl?.textContent?.trim() || '';

          // Extract likes
          const likesEl = el.querySelector('[data-e2e="comment-like-count"]') ||
                         el.querySelector('[class*="like-count"]');
          let likes = 0;
          if (likesEl) {
            const likesText = likesEl.textContent?.trim() || '0';
            likes = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
          }

          // Extract relative time (e.g., "2d ago", "1w ago")
          const timeEl = el.querySelector('[data-e2e="comment-time"]') ||
                        el.querySelector('span[class*="time"]') ||
                        el.querySelector('time');
          const relativeTime = timeEl?.textContent?.trim() || '';

          if (username && commentText) {
            results.push({ username, commentText, likes, relativeTime, selectorUsed });
          }
        } catch (err) {
          console.error('Error extracting comment:', err);
        }
      });

      return { results, selectorUsed, totalFound: commentElements.length };
    }); // Close page.evaluate()

    console.log(`[Comment Scraper] Evaluation result:`, JSON.stringify(comments).substring(0, 200));

    // Handle diagnostic info
    if ('diagnostics' in comments) {
      console.log(`[Comment Scraper] No comments found. Diagnostics:`, comments.diagnostics);
      return [];
    }

    const { results, selectorUsed, totalFound } = comments as any;
    console.log(`[Comment Scraper] Found ${totalFound} comment elements using selector: ${selectorUsed}`);
    console.log(`[Comment Scraper] Extracted ${results.length} valid comments (with username and text)`);

    if (results.length === 0) {
      return [];
    }

    // Parse relative times and filter to last 7 days
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const recentComments: TikTokComment[] = results
      .map((comment: any) => {
        const postedAt = parseRelativeTime(comment.relativeTime);
        return {
          username: comment.username,
          commentText: comment.commentText,
          likes: comment.likes,
          postedAt
        };
      })
      .filter(comment => {
        // Filter to comments from last 7 days
        if (!comment.postedAt) {
          // If we can't parse the time, include it (might be recent)
          return true;
        }
        return comment.postedAt >= oneWeekAgo;
      });

    console.log(`[Comment Scraper] ${recentComments.length} comments from last 7 days`);

    // Send event to user
    sendUserEvent(userId, {
      type: 'info',
      text: `Scraped ${recentComments.length} recent comments from post`,
      url: videoUrl
    });

    return recentComments;

  } catch (error: any) {
    console.error(`[Comment Scraper] Error: ${error.message}`);
    sendUserEvent(userId, {
      type: 'error',
      text: `Failed to scrape comments: ${error.message}`
    });
    return [];
  }
}

/**
 * Parse TikTok relative time strings like "2d ago", "1w ago", "3h ago"
 * Returns null if can't parse
 */
function parseRelativeTime(relativeTime: string): Date | null {
  if (!relativeTime) return null;

  const now = new Date();
  const match = relativeTime.match(/(\d+)\s*([smhdw])/i);
  
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': // seconds
      return new Date(now.getTime() - value * 1000);
    case 'm': // minutes
      return new Date(now.getTime() - value * 60 * 1000);
    case 'h': // hours
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case 'd': // days
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    case 'w': // weeks
      return new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

/**
 * Scrape comments for all unprocessed posts for a user
 * Stores comments in the database
 */
export async function scrapeCommentsForUser(userId: number): Promise<void> {
  const connection = await db.getConnection();
  
  try {
    console.log(`[Comment Scraper] Starting comment scraping for user ${userId}`);
    
    sendUserEvent(userId, {
      type: 'info',
      text: 'Starting comment scraping...'
    });

    // Get unprocessed posts (posts we haven't scraped comments for yet)
    const [posts]: any = await connection.query(
      `SELECT p.id, p.video_url, p.username, p.caption
       FROM tiktok_posts p
       JOIN tiktok_accounts a ON p.account_id = a.id
       WHERE a.user_id = ? 
         AND (p.processed = 0 OR p.scraped_comments_at IS NULL)
         AND p.found_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY p.found_at DESC
       LIMIT 20`,
      [userId]
    );

    if (!posts || posts.length === 0) {
      console.log(`[Comment Scraper] No unprocessed posts found for user ${userId}`);
      sendUserEvent(userId, {
        type: 'info',
        text: 'No new posts to scrape comments from'
      });
      return;
    }

    console.log(`[Comment Scraper] Found ${posts.length} posts to scrape`);
    sendUserEvent(userId, {
      type: 'info',
      text: `Found ${posts.length} posts to scrape comments from`
    });

    let totalComments = 0;

    // Scrape comments for each post
    for (const post of posts) {
      console.log(`[Comment Scraper] Processing post ${post.id}: ${post.video_url}`);
      
      // Send post header to Live Feed
      sendUserEvent(userId, {
        type: 'post-header',
        text: `${post.username}`,
        url: post.video_url
      });
      
      const comments = await scrapeCommentsFromPost(post.id, post.video_url, userId);

      if (comments.length > 0) {
        console.log(`[Comment Scraper] Found ${comments.length} comments for post ${post.id}`);
        
        // Insert comments into database and send to Live Feed
        for (const comment of comments) {
          try {
            await connection.query(
              `INSERT INTO tiktok_comments 
               (post_id, username, comment_text, likes, posted_at)
               VALUES (?, ?, ?, ?, ?)`,
              [
                post.id,
                comment.username,
                comment.commentText,
                comment.likes,
                comment.postedAt
              ]
            );
            totalComments++;
            
            // Calculate days ago
            const daysAgo = comment.postedAt 
              ? Math.floor((Date.now() - comment.postedAt.getTime()) / (1000 * 60 * 60 * 24))
              : null;
            
            const timeAgoText = daysAgo !== null 
              ? `${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago`
              : 'recently';
            
            // Send comment to Live Feed
            sendUserEvent(userId, {
              type: 'comment',
              text: `"${comment.commentText}"\n@${comment.username}\n${timeAgoText}`,
              url: `https://www.tiktok.com/@${comment.username}`
            });
            
            console.log(`[Comment Scraper] Added comment by @${comment.username}: "${comment.commentText.substring(0, 50)}..."`);
            
          } catch (err: any) {
            // Ignore duplicate errors
            if (!err.message.includes('Duplicate')) {
              console.error(`[Comment Scraper] Error inserting comment: ${err.message}`);
            }
          }
        }
      } else {
        console.log(`[Comment Scraper] No recent comments found for post ${post.id}`);
        sendUserEvent(userId, {
          type: 'info',
          text: 'No recent comments (< 7 days)'
        });
      }

      // Mark post as processed
      await connection.query(
        `UPDATE tiktok_posts 
         SET processed = 1, scraped_comments_at = NOW() 
         WHERE id = ?`,
        [post.id]
      );

      // Wait between posts to avoid detection
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`[Comment Scraper] Completed. Scraped ${totalComments} total comments`);
    
    sendUserEvent(userId, {
      type: 'success',
      text: `✅ Scraped ${totalComments} comments from ${posts.length} posts`
    });

  } catch (error: any) {
    console.error(`[Comment Scraper] Error: ${error.message}`);
    sendUserEvent(userId, {
      type: 'error',
      text: `Comment scraping failed: ${error.message}`
    });
  } finally {
    connection.release();
  }
}
