import puppeteer from 'puppeteer-core';
import db from '../config/database.js';
import { sendUserEvent } from '../events/broadcaster.js';
import { analyzeCommentsForBuyingIntent } from '../services/openai.js';
import { engageWithUser } from '../services/engagement.js';

interface TikTokPost {
  username: string;
  caption: string;
  videoUrl: string;
  likes: number;
  comments: number;
  shares: number;
  timestamp: Date;
}

/**
 * Parse TikTok time strings - handles relative, absolute dates, and special cases
 */
function parseRelativeTime(relativeTime: string): Date | null {
  if (!relativeTime) return null;

  const now = new Date();
  const timeStr = relativeTime.trim();
  
  // Special cases
  if (timeStr.toLowerCase() === 'just now') {
    return now;
  }
  
  if (timeStr.toLowerCase() === 'yesterday') {
    now.setDate(now.getDate() - 1);
    return now;
  }
  
  // Relative time format (e.g., "2d ago", "5h ago", "3w ago")
  const relativeMatch = timeStr.match(/(\d+)\s*([smhdw])\s*ago/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    
    switch (unit) {
      case 's': // seconds
        now.setSeconds(now.getSeconds() - value);
        break;
      case 'm': // minutes
        now.setMinutes(now.getMinutes() - value);
        break;
      case 'h': // hours
        now.setHours(now.getHours() - value);
        break;
      case 'd': // days
        now.setDate(now.getDate() - value);
        break;
      case 'w': // weeks
        now.setDate(now.getDate() - (value * 7));
        break;
      default:
        return null;
    }
    
    return now;
  }
  
  // Absolute date formats
  // Format 1: YYYY-MM-DD (for posts from last year)
  const isoDateMatch = timeStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoDateMatch) {
    const year = parseInt(isoDateMatch[1]);
    const month = parseInt(isoDateMatch[2]) - 1; // JS months are 0-indexed
    const day = parseInt(isoDateMatch[3]);
    return new Date(year, month, day);
  }
  
  // Format 2: "12-22" or "1-5" (MM-DD or M-D for posts this year)
  const shortDateMatch = timeStr.match(/^(\d{1,2})-(\d{1,2})$/);
  if (shortDateMatch) {
    const month = parseInt(shortDateMatch[1]) - 1; // JS months are 0-indexed
    const day = parseInt(shortDateMatch[2]);
    const currentYear = now.getFullYear();
    return new Date(currentYear, month, day);
  }
  
  // Format 3: "12/22" or "1/5" (MM/DD or M/D)
  const slashDateMatch = timeStr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slashDateMatch) {
    const month = parseInt(slashDateMatch[1]) - 1;
    const day = parseInt(slashDateMatch[2]);
    const currentYear = now.getFullYear();
    return new Date(currentYear, month, day);
  }
  
  // Format 4: "Jan 18" or "Dec 22" (assumes current year, or previous year if in future)
  const monthDayMatch = timeStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
  if (monthDayMatch) {
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = monthNames.indexOf(monthDayMatch[1].toLowerCase());
    const day = parseInt(monthDayMatch[2]);
    const currentYear = now.getFullYear();
    
    // Create date with current year
    let date = new Date(currentYear, month, day);
    
    // If date is in the future, it must be from last year
    if (date > now) {
      date = new Date(currentYear - 1, month, day);
    }
    
    return date;
  }
  
  // Could not parse
  return null;
}

/**
 * Search TikTok for ONE keyword at a time (realistic usage pattern)
 * Returns posts found and the next keyword index to use
 */
export async function searchTikTokByKeywords(
  accountId: number, 
  keywords: string[], 
  keywordIndex: number = 0,
  userId?: number,
  userConfig?: any
): Promise<{ posts: TikTokPost[], nextKeywordIndex: number }> {
  const connection = await db.getConnection();
  
  try {
    // Get account session info
    const [rows] = await connection.query(
      'SELECT session_data FROM tiktok_accounts WHERE id = ? AND is_active = 1 LIMIT 1',
      [accountId]
    );
    
    if (!rows || (rows as any[]).length === 0) {
      throw new Error(`Account ${accountId} not found or inactive`);
    }
    
    const sessionData = JSON.parse((rows as any[])[0].session_data || '{}');
    
    // Verify Chrome is running
    if (!sessionData.ready) {
      throw new Error(`Account ${accountId} not ready - user must launch Chrome and login first`);
    }
    
    // Connect to local Chrome (always on port 9222)
    console.log(`[TikTok Search] Connecting to local Chrome for account ${accountId}`);
    
    const browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222',
      protocolTimeout: 120000 // 2 minutes
    });
    
    const page = await browser.newPage();
    
    const foundPosts: TikTokPost[] = [];
    
    // ONLY SEARCH ONE KEYWORD to avoid bot detection
    // Rotate through keywords on subsequent searches
    const keyword = keywords[keywordIndex % keywords.length];
    const nextKeywordIndex = (keywordIndex + 1) % keywords.length;
    
    console.log(`[TikTok Search] Searching for keyword: "${keyword}" (index ${keywordIndex}/${keywords.length - 1})`);
    
    try {
      // Navigate to TikTok search
      await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
    } catch (navError) {
      console.log(`[TikTok Search] Navigation timeout for keyword: ${keyword}, continuing...`);
      // Continue anyway, page might have loaded partially
    }
      
      // Debug: check page title and URL to see if we're logged in
      const pageTitle = await page.title();
      const pageUrl = page.url();
      console.log(`[TikTok Search] Page loaded: ${pageTitle} | ${pageUrl}`);
      
      // Wait for loading skeletons to disappear (TikTok shows skeleton placeholders while loading)
      console.log(`[TikTok Search] Waiting for content to load (skeletons to disappear)...`);
      try {
        // Wait for skeleton containers to disappear
        await page.waitForFunction(
          () => {
            const skeletons = document.querySelectorAll('[data-e2e="video-skeleton-container"]');
            return skeletons.length === 0;
          },
          { timeout: 15000 }
        );
        console.log(`[TikTok Search] Skeletons cleared, checking for results...`);
      } catch (e) {
        console.log(`[TikTok Search] Timeout waiting for skeletons to clear, checking anyway...`);
      }
      
      // Try multiple possible selectors for video items (based on actual TikTok HTML structure)
      const possibleSelectors = [
        '[data-e2e="feed-video"]',  // Actual selector TikTok uses!
        'section[data-e2e="feed-video"]',
        '[data-e2e="search-video-item"]',
        '[data-e2e="search-card-video-container"]',
        'section[id^="media-card-"]',
        'div[data-e2e*="search"][data-e2e*="video"]'
      ];
      
      let foundSelector = null;
      for (const selector of possibleSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3000 });
          const count = await page.$$eval(selector, els => els.length);
          if (count > 0) {
            foundSelector = selector;
            console.log(`[TikTok Search] Found ${count} items using selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }
      
      if (!foundSelector) {
        console.log(`[TikTok Search] No video items found with any known selector for keyword: ${keyword}`);
      }
      
      // Debug: check what's actually on the page
      let pageInfo;
      try {
        pageInfo = await page.evaluate(() => {
          const bodyText = document.body.innerText.substring(0, 500);
          const allDataE2e = Array.from(document.querySelectorAll('[data-e2e]')).map(el => el.getAttribute('data-e2e')).slice(0, 20);
          const isLoginPrompt = bodyText.includes('Log in') || bodyText.includes('Use QR code') || bodyText.includes('Use phone / email');
          const isErrorPage = bodyText.includes('Page not available') || bodyText.includes('Sorry about that');
          return { bodyText, allDataE2e, isLoginPrompt, isErrorPage };
        });
      } catch (evalError) {
        console.log(`[TikTok Search] Could not evaluate page for keyword: ${keyword} - page may be unresponsive`);
        await browser.disconnect();
        return { posts: [], nextKeywordIndex };
      }
      
      // Check for login prompt
      if (pageInfo.isLoginPrompt) {
        console.log(`[TikTok Search] ⚠️ LOGIN REQUIRED - Cookies are not working! TikTok is showing login prompt.`);
        console.log(`[TikTok Search] Page content: ${pageInfo.bodyText.substring(0, 200)}`);
        throw new Error('TikTok requires login - cookies may be expired or invalid');
      }
      
      // Check for error page
      if (pageInfo.isErrorPage) {
        console.log(`[TikTok Search] ⚠️ ERROR PAGE - TikTok blocked the request (rate limit or detection)`);
        console.log(`[TikTok Search] Page content: ${pageInfo.bodyText.substring(0, 200)}`);
        throw new Error('TikTok error page - may be rate limited or detected as bot');
      }
      
      // Extract post data using multiple strategies - but now we'll click each video
      let posts = [];
      try {
        // First, get all video elements from search results
        const videoElements = await page.evaluate(() => {
          // Try multiple selectors for video containers
          let items: Element[] = [];
          const selectors = [
            '[data-e2e="feed-video"]',
            'section[data-e2e="feed-video"]',
            '[data-e2e="search-video-item"]',
            'section[id^="media-card-"]'
          ];
          
          for (const selector of selectors) {
            items = Array.from(document.querySelectorAll(selector));
            if (items.length > 0) break;
          }
          
          // If still no items, find all links to videos
          if (items.length === 0) {
            const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
            items = videoLinks.map(link => {
              let parent = link.parentElement;
              for (let i = 0; i < 5 && parent; i++) {
                parent = parent.parentElement;
                if (parent && parent.querySelector('a[href*="/@"]')) {
                  return parent;
                }
              }
              return link.parentElement;
            }).filter((el): el is Element => el !== null);
          }
          
          // Return element indices so we can click them later
          return items.slice(0, 10).map((item, index) => index);
        });
        
        console.log(`[TikTok Search] Found ${videoElements.length} videos, will click each one to extract comments...`);
        
        // For each video, click it and extract all data
        for (let videoIndex of videoElements) {
          try {
            // Click the video to open it
            await page.evaluate((index: number) => {
              const selectors = [
                '[data-e2e="feed-video"]',
                'section[data-e2e="feed-video"]',
                '[data-e2e="search-video-item"]',
                'section[id^="media-card-"]'
              ];
              
              let items: Element[] = [];
              for (const selector of selectors) {
                items = Array.from(document.querySelectorAll(selector));
                if (items.length > 0) break;
              }
              
              if (items.length === 0) {
                const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
                items = videoLinks.map(link => {
                  let parent = link.parentElement;
                  for (let i = 0; i < 5 && parent; i++) {
                    parent = parent.parentElement;
                    if (parent && parent.querySelector('a[href*="/@"]')) {
                      return parent;
                    }
                  }
                  return link.parentElement;
                }).filter((el): el is Element => el !== null);
              }
              
              const item = items[index];
              if (item) {
                const link = item.querySelector('a[href*="/video/"]') as HTMLElement;
                if (link) link.click();
              }
            }, videoIndex);
            
            console.log(`[TikTok Search] Clicked video ${videoIndex + 1}/${videoElements.length}, waiting for page load...`);
            
            // Wait for URL to change (navigation completion)
            try {
              await page.waitForFunction(
                () => window.location.href.includes('/video/'),
                { timeout: 5000 }
              );
              // Extra wait for content to render after URL changes
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (err) {
              console.log(`[TikTok Search] URL didn't change to video page, waiting anyway...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Wait for ACTUAL video page content to load (not just the shell)
            console.log(`[TikTok Search] Waiting for video page content to render...`);
            try {
              // Wait for these specific video page elements
              await page.waitForSelector('[data-e2e="browse-video"], [data-e2e="browse-username"], [data-e2e="comment-icon"], video', { 
                timeout: 15000 
              });
              console.log(`[TikTok Search] Video content detected!`);
              
              // Wait additional time for comments section to render
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              // Click the comments button to reveal the comments section
              console.log(`[TikTok Search] Clicking comments button to reveal comments...`);
              try {
                await page.evaluate(() => {
                  // Find the comments button by the comment icon data-e2e attribute
                  const commentIcon = document.querySelector('[data-e2e="comment-icon"]');
                  if (commentIcon) {
                    // Get the button parent
                    const button = commentIcon.closest('button');
                    if (button) {
                      (button as HTMLElement).click();
                      return true;
                    }
                  }
                  return false;
                });
                console.log(`[TikTok Search] Comments button clicked!`);
                
                // Wait for comments section to open
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Try to wait for comment section specifically
                await page.waitForSelector('[data-e2e="comment-list"], [data-e2e="browse-comment-list"], [data-e2e="comment-item"]', { 
                  timeout: 5000 
                }).catch(() => {
                  console.log(`[TikTok Search] Comment section still not visible after clicking`);
                });
                
              } catch (clickErr) {
                console.log(`[TikTok Search] Could not click comments button:`, clickErr);
              }
              
            } catch (err) {
              console.log(`[TikTok Search] Video page content didn't load, skipping this video`);
              await page.goBack();
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
            
            // Scroll the comments section multiple times to load more comments (lazy loading)
            // Using scrollIntoView approach from StackOverflow - more reliable for lazy loading
            console.log(`[TikTok Search] Scrolling comments section to load more comments...`);
            try {
              const delay = 2000; // 2 seconds between scroll checks
              let preCount = 0;
              let postCount = 0;
              let scrollAttempts = 0;
              const maxScrollAttempts = 100; // Prevent infinite loop
              
              // Initial diagnostic check
              const initialDiagnostics = await page.evaluate(() => {
                const comments = document.querySelectorAll('[data-e2e="comment-level-1"]');
                const lastComment = document.querySelector('[data-e2e="comment-level-1"]:last-child');
                return {
                  commentCount: comments.length,
                  hasLastComment: !!lastComment,
                  lastCommentVisible: lastComment ? (lastComment as HTMLElement).offsetParent !== null : false
                };
              });
              console.log(`[TikTok Search] 🔍 Initial scroll diagnostics:`, initialDiagnostics);
              
              do {
                preCount = await page.evaluate(() => {
                  return document.querySelectorAll('[data-e2e="comment-level-1"]').length;
                });
                
                // Scroll to the last comment (triggers lazy loading)
                await page.evaluate(() => {
                  const lastComment = document.querySelector('[data-e2e="comment-level-1"]:last-child');
                  if (lastComment) {
                    lastComment.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'end' });
                  }
                });
                
                await new Promise(resolve => setTimeout(resolve, delay));
                
                postCount = await page.evaluate(() => {
                  return document.querySelectorAll('[data-e2e="comment-level-1"]').length;
                });
                
                scrollAttempts++;
                
                if (scrollAttempts % 5 === 0 || postCount > preCount) {
                  console.log(`[TikTok Search] 📊 Scroll attempt ${scrollAttempts}: ${preCount} → ${postCount} comments (${postCount > preCount ? '+' + (postCount - preCount) : 'no change'})`);
                }
                
                // Break if we've scrolled too many times (safety)
                if (scrollAttempts >= maxScrollAttempts) {
                  console.log(`[TikTok Search] Reached max scroll attempts (${maxScrollAttempts}), stopping`);
                  break;
                }
                
              } while (postCount > preCount); // Keep scrolling while new comments load
              
              await new Promise(resolve => setTimeout(resolve, delay)); // Final wait
              
              const finalCount = await page.evaluate(() => {
                return document.querySelectorAll('[data-e2e="comment-level-1"]').length;
              });
              
              console.log(`[TikTok Search] ✅ Finished scrolling after ${scrollAttempts} attempts: loaded ${finalCount} comments`);
            } catch (scrollErr) {
              console.log(`[TikTok Search] ❌ Error scrolling comments:`, scrollErr);
            }
            
            // Wait for final batch of comments to load
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Verify comment count matches button count
            const countVerification = await page.evaluate(() => {
              const commentButton = document.querySelector('[data-e2e="comment-icon"]')?.closest('button');
              const countElement = commentButton?.querySelector('[data-e2e="comment-count"]');
              const expectedCount = countElement ? parseInt(countElement.textContent || '0', 10) : 0;
              const scrapedCount = document.querySelectorAll('[data-e2e="comment-level-1"]').length;
              return { expectedCount, scrapedCount };
            });
            
            if (countVerification.expectedCount > 0) {
              const percentage = Math.round((countVerification.scrapedCount / countVerification.expectedCount) * 100);
              console.log(`[TikTok Search] 📊 Comment count verification: scraped ${countVerification.scrapedCount}/${countVerification.expectedCount} (${percentage}%)`);
              
              if (countVerification.scrapedCount >= countVerification.expectedCount * 0.9) {
                console.log(`[TikTok Search] ✅ Comments successfully scraped!`);
                sendUserEvent(userId, 'success', `✅ Comments successfully scraped! (${countVerification.scrapedCount}/${countVerification.expectedCount})`);
              } else {
                console.log(`[TikTok Search] ⚠️ Only scraped ${percentage}% of comments`);
                sendUserEvent(userId, 'warning', `⚠️ Only scraped ${countVerification.scrapedCount}/${countVerification.expectedCount} comments (${percentage}%)`);
              }
            }
            
            // Extract video data and comments from this page
            const videoData = await page.evaluate(() => {
              // Diagnostic: Check what we have on the page
              const diagnostics = {
                url: window.location.href,
                title: document.title,
                hasVideo: !!document.querySelector('video'),
                allDataE2E: Array.from(document.querySelectorAll('[data-e2e]'))
                  .slice(0, 20)
                  .map(el => el.getAttribute('data-e2e'))
              };
              
              // Extract post data with multiple fallback selectors
              const usernameEl = document.querySelector('[data-e2e="browse-username"]') ||
                                document.querySelector('[data-e2e="creator-nickname"]') ||
                                document.querySelector('a[href^="/@"]') ||
                                document.querySelector('[class*="author"]');
              let username = usernameEl?.textContent?.trim().replace('@', '') || '';
              
              const captionEl = document.querySelector('[data-e2e="browse-video-desc"]') ||
                              document.querySelector('[data-e2e="video-desc"]') ||
                              document.querySelector('[class*="video-desc"]');
              const caption = captionEl?.textContent?.trim() || '';
              
              const videoUrl = window.location.href;
              
              // Fallback: Extract username from URL if not found in elements
              if (!username) {
                const urlMatch = videoUrl.match(/@([^/]+)/);
                if (urlMatch) {
                  username = urlMatch[1];
                  console.log('[TikTok Extract] Username extracted from URL:', username, 'from', videoUrl);
                } else {
                  console.log('[TikTok Extract] Failed to extract username from URL:', videoUrl);
                }
              } else {
                console.log('[TikTok Extract] Username found in page elements:', username);
              }
              
              // Extract engagement metrics
              const likesEl = document.querySelector('[data-e2e="like-count"]') ||
                             document.querySelector('[data-e2e="browse-like-count"]') ||
                             document.querySelector('[class*="like-count"]');
              const likes = parseInt(likesEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
              
              const commentsCountEl = document.querySelector('[data-e2e="comment-count"]') ||
                                     document.querySelector('[data-e2e="browse-comment-count"]') ||
                                     document.querySelector('[class*="comment-count"]');
              const commentsCount = parseInt(commentsCountEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
              
              const sharesEl = document.querySelector('[data-e2e="share-count"]') ||
                              document.querySelector('[class*="share-count"]');
              const shares = parseInt(sharesEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
              
              // Extract comments
              const commentSelectors = [
                '[data-e2e="comment-item"]',
                '[data-e2e="comment-level-1"]',
                'div[class*="CommentItem"]',
                'div[class*="comment-item"]',
                '[data-e2e="comment-list"] > div',
                'div[class*="Comment"]'
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
              
              const comments = commentElements.map(el => {
                try {
                  // Username: look for data-e2e starts with "comment-username" (has number suffix)
                  const usernameContainer = el.closest('[class*="DivCommentItemWrapper"]')?.querySelector('[data-e2e^="comment-username"]');
                  const commentUsername = (usernameContainer?.querySelector('a p') || 
                                          usernameContainer?.querySelector('p'))?.textContent?.trim().replace('@', '') || '';
                  
                  // Comment text: it's a child span of the comment-level-1 element
                  const commentText = (el.querySelector('span.TUXText') || 
                                      el.querySelector('span'))?.textContent?.trim() || '';
                  
                  // Likes: look in the parent comment wrapper
                  const likeContainer = el.closest('[class*="DivCommentItemWrapper"]')?.querySelector('[class*="DivLikeContainer"]');
                  const commentLikes = parseInt((likeContainer?.querySelector('span'))?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
                  
                  // Time: look for all span elements and find the one with time text
                  // TikTok formats: "5d ago", "2h ago", "Yesterday", "Just now", "12-22", "2024-01-15", "Jan 18"
                  const wrapper = el.closest('[class*="DivCommentItemWrapper"]');
                  const allSpans = Array.from(wrapper?.querySelectorAll('span') || []);
                  
                  let relativeTime = '';
                  for (const span of allSpans) {
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
                    relativeTime
                  };
                } catch (err) {
                  return null;
                }
              }).filter(c => c && c.username && c.text);
              
              return {
                diagnostics,
                selectorUsed,
                commentElementCount: commentElements.length,
                post: { username, caption, videoUrl, likes, commentsCount, shares },
                comments
              };
            });
            
            // Log diagnostics
            console.log(`[TikTok Search] Page diagnostics:`, JSON.stringify(videoData.diagnostics, null, 2));
            console.log(`[TikTok Search] Found ${videoData.commentElementCount} comment elements using selector: ${videoData.selectorUsed || 'NONE'}`);
            console.log(`[TikTok Search] Extracted post from @${videoData.post.username} with ${videoData.comments.length} total comments`);
            console.log(`[TikTok Search] Video URL captured: ${videoData.post.videoUrl}`);
            console.log(`[TikTok Search] 📋 COMMENT COUNT CHECK: Expected many comments if scrolling worked, got ${videoData.comments.length} comments`);
            
            // Filter comments to only those from the last 7 days
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            
            const filteredComments = videoData.comments.filter(comment => {
              const postedAt = parseRelativeTime(comment.relativeTime);
              // Only include comments from last 7 days
              if (!postedAt) {
                console.log(`[TikTok Search] Warning: Could not parse time "${comment.relativeTime}" for comment by @${comment.username}`);
                return false; // Exclude if we can't parse the time
              }
              const isRecent = postedAt >= oneWeekAgo;
              if (!isRecent) {
                console.log(`[TikTok Search] Filtering out old comment from ${comment.relativeTime} (@${comment.username}): ${comment.text.substring(0, 50)}...`);
              }
              return isRecent;
            });
            
            console.log(`[TikTok Search] After filtering: ${filteredComments.length} comments from last 7 days (filtered out ${videoData.comments.length - filteredComments.length} old comments)`);
            
            // Replace comments with filtered ones
            videoData.comments = filteredComments;
            
            // === OPENAI ANALYSIS & ENGAGEMENT ===
            // Only proceed if we have user config and comments to analyze
            if (userId && userConfig && filteredComments.length > 0) {
              try {
                console.log(`[TikTok Search] Analyzing ${filteredComments.length} comments for buying intent...`);
                
                // Send to OpenAI for buying intent analysis
                const buyingIntentResults = await analyzeCommentsForBuyingIntent(
                  filteredComments,
                  videoData.post.videoUrl,
                  userConfig
                );
                
                console.log(`[TikTok Search] OpenAI identified ${buyingIntentResults.filter(r => r.hasBuyingIntent).length} comments with buying intent`);
                
                // Engage with users who have buying intent
                for (const result of buyingIntentResults) {
                  if (result.hasBuyingIntent && result.customizedDM && result.customizedReply) {
                    // Find the original comment to display with the engagement message
                    const originalComment = filteredComments.find(c => c.username === result.username);
                    const commentPreview = originalComment ? originalComment.text.substring(0, 100) : '';
                    
                    console.log(`[TikTok Search] 🎯 Buying intent detected from @${result.username}`);
                    console.log(`[TikTok Search] Comment: "${commentPreview}"`);
                    
                    // Show the comment in Live Feed
                    sendUserEvent(userId, {
                      type: 'comment',
                      text: `${commentPreview}\n@${result.username}\n${originalComment?.relativeTime || ''}`,
                      url: `https://www.tiktok.com/@${result.username}`
                    });
                    
                    // Announce engagement attempt
                    sendUserEvent(userId, {
                      type: 'info',
                      text: `📤 Sending DM to @${result.username}...`
                    });
                    
                    const engagementResult = await engageWithUser(
                      page,
                      userId,
                      accountId,
                      result.username,
                      videoData.post.videoUrl,
                      result.customizedDM,
                      result.customizedReply
                    );
                    
                    // Send live feed notification based on result
                    if (engagementResult.success) {
                      if (engagementResult.method === 'dm') {
                        sendUserEvent(userId, {
                          type: 'success',
                          text: `✅ Successfully sent DM!`
                        });
                        // Show the DM text
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `📩 "${result.customizedDM}"`
                        });
                      } else if (engagementResult.method === 'comment') {
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `❌ Failed to send DM. Leaving reply to comment...`
                        });
                        sendUserEvent(userId, {
                          type: 'success',
                          text: `✅ Reply successfully posted!`
                        });
                        // Show the comment text
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `💬 "${result.customizedReply}"`
                        });
                      }
                    } else if (engagementResult.method === 'skipped') {
                      sendUserEvent(userId, {
                        type: 'info',
                        text: `⏭️ Skipped @${result.username} - already contacted`
                      });
                    } else {
                      // Both DM and comment failed
                      sendUserEvent(userId, {
                        type: 'info',
                        text: `❌ Failed to send DM. Leaving reply to comment...`
                      });
                      sendUserEvent(userId, {
                        type: 'error',
                        text: `❌ Failed to post reply: ${engagementResult.error}`
                      });
                    }
                    
                    // Wait between engagements to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 3000));
                  }
                }
                
              } catch (aiError) {
                console.error(`[TikTok Search] Error in OpenAI analysis or engagement:`, aiError);
                if (userId) {
                  sendUserEvent(userId, {
                    type: 'error',
                    text: `⚠️ AI analysis failed: ${aiError instanceof Error ? aiError.message : 'Unknown error'}`
                  });
                }
              }
            }
            
            posts.push(videoData);
            
            // Go back to search results
            await page.goBack();
            await new Promise(resolve => setTimeout(resolve, 2000));
            
          } catch (videoError) {
            console.error(`[TikTok Search] Error processing video ${videoIndex + 1}:`, videoError);
            // Try to go back to search results if we're stuck
            try {
              await page.goBack();
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (backError) {
              console.error('[TikTok Search] Could not go back to search results');
            }
          }
        }
        
      } catch (extractError) {
        console.log(`[TikTok Search] Could not extract posts for keyword: ${keyword} - timeout or error`);
        posts = [];
      }
      
      if (posts.length > 0) {
        console.log(`[TikTok Search] Extracted ${posts.length} posts with comments for keyword: ${keyword}`);
      }
      
      return { posts, nextKeywordIndex };
    
  } catch (error) {
    console.error(`[TikTok Search] Error searching for account ${accountId}:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Run TikTok search for a specific user's accounts
 */
export async function runTikTokSearchForAccounts(userId: number) {
  const connection = await db.getConnection();
  
  try {
    console.log(`[TikTok Search Worker] Starting search for user ${userId} accounts...`);
    
    // Get user's active TikTok accounts with their last keyword index
    const [accounts] = await connection.query(
      'SELECT id, last_keyword_index FROM tiktok_accounts WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    
    if (!accounts || (accounts as any[]).length === 0) {
      console.log('[TikTok Search Worker] No active accounts found');
      return;
    }
    
    // Get user's keywords from config
    const [configRows] = await connection.query(
      'SELECT keywords, ai_prompt, example_dm, example_comment, openai_api_key FROM user_config WHERE user_id = ?',
      [userId]
    );
    
    if (!configRows || (configRows as any[]).length === 0) {
      console.log('[TikTok Search Worker] No keywords configured');
      return;
    }
    
    const configData = (configRows as any[])[0];
    const keywordsStr = configData.keywords || '';
    const keywords = keywordsStr.split(',').map((k: string) => k.trim()).filter((k: string) => k);
    
    if (keywords.length === 0) {
      console.log('[TikTok Search Worker] No valid keywords found');
      return;
    }
    
    // Prepare user config for OpenAI
    const userConfig = {
      aiPrompt: configData.ai_prompt,
      exampleDM: configData.example_dm,
      exampleComment: configData.example_comment,
      openaiApiKey: configData.openai_api_key
    };
    
    if (keywords.length === 0) {
      console.log('[TikTok Search Worker] No valid keywords found');
      return;
    }
    
    console.log(`[TikTok Search Worker] Keywords configured: ${keywords.join(', ')}`);
    console.log(`[TikTok Search Worker] Will search ONE keyword per account to avoid bot detection`);
    
    // Search for each account (ONE keyword each)
    for (const account of accounts as any[]) {
      try {
        const keywordIndex = account.last_keyword_index || 0;
        const keyword = keywords[keywordIndex];
        
        // Send live feed event: searching
        sendUserEvent(userId, { 
          type: 'info', 
          text: `Searching for "${keyword}"...` 
        });
        
        const result = await searchTikTokByKeywords(account.id, keywords, keywordIndex, userId, userConfig);
        
        console.log(`[TikTok Search Worker] Extracted ${result.posts.length} posts, beginning database insert...`);
        
        // Store posts in database along with their comments
        let storedCount = 0;
        for (const videoData of result.posts) {
          try {
            const post = videoData.post;
            console.log(`[TikTok Search Worker] Inserting: @${post.username} - ${post.videoUrl}`);
            
            // Insert the post
            const [postResult] = await connection.query(
              `INSERT INTO tiktok_posts (account_id, username, caption, video_url, likes, comments, shares, found_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE 
                 likes = VALUES(likes), 
                 comments = VALUES(comments),
                 id = LAST_INSERT_ID(id)`,
              [account.id, post.username, post.caption, post.videoUrl, post.likes, post.commentsCount, post.shares]
            );
            
            // Get the post ID (either newly inserted or existing)
            const postId = (postResult as any).insertId;
            
            // Parse and filter comments to last 7 days
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            
            let recentComments = 0;
            for (const comment of videoData.comments) {
              // Parse relative time
              const postedAt = parseRelativeTime(comment.relativeTime);
              
              // Skip if older than 7 days
              if (postedAt && postedAt < oneWeekAgo) {
                continue;
              }
              
              // Insert comment
              try {
                await connection.query(
                  `INSERT INTO tiktok_comments (post_id, username, comment_text, likes, posted_at, scraped_at)
                   VALUES (?, ?, ?, ?, ?, NOW())
                   ON DUPLICATE KEY UPDATE likes = VALUES(likes)`,
                  [postId, comment.username, comment.text, comment.likes, postedAt || null]
                );
                recentComments++;
              } catch (commentError) {
                console.error(`[TikTok Search Worker] Failed to insert comment:`, commentError);
              }
            }
            
            console.log(`[TikTok Search Worker] Stored ${recentComments} recent comments for post ${postId}`);
            storedCount++;
            
          } catch (insertError) {
            console.error(`[TikTok Search Worker] ❌ Failed to insert post:`, insertError);
            console.error(`[TikTok Search Worker] Post data:`, JSON.stringify(videoData, null, 2));
          }
        }
        
        console.log(`[TikTok Search Worker] ✅ Successfully stored ${storedCount}/${result.posts.length} posts with comments`);
        
        // Update last_keyword_index and last_search_at for rotation
        await connection.query(
          'UPDATE tiktok_accounts SET last_keyword_index = ?, last_search_at = NOW() WHERE id = ?',
          [result.nextKeywordIndex, account.id]
        );
        
        console.log(`[TikTok Search Worker] Next search will use keyword index ${result.nextKeywordIndex}`);
        
        // Send live feed events for each video with comments
        if (result.posts.length > 0) {
          // Deduplicate posts by URL before sending to live feed
          const seenUrls = new Set<string>();
          const uniquePosts = result.posts.filter((videoData) => {
            if (seenUrls.has(videoData.post.videoUrl)) {
              return false;
            }
            seenUrls.add(videoData.post.videoUrl);
            return true;
          });
          
          sendUserEvent(userId, { 
            type: 'success', 
            text: `Found ${uniquePosts.length} posts mentioning "${keyword}"` 
          });
          
          // Send post header + comments in the format requested
          // Note: Events are prepended in UI (newest first), so we need to send in reverse order
          // We send posts in REVERSE order, and for each post: header THEN comments
          // This way in the UI (which reverses), the FIRST post header will be at the top
          for (let i = uniquePosts.length - 1; i >= 0; i--) {
            const videoData = uniquePosts[i];
            const post = videoData.post;
            
            // Filter to recent comments (< 7 days)
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            
            const recentComments = videoData.comments.filter(comment => {
              const postedAt = parseRelativeTime(comment.relativeTime);
              return !postedAt || postedAt >= oneWeekAgo;
            });
            
            // Send comments in REVERSE order (FIRST)
            for (let j = recentComments.length - 1; j >= 0; j--) {
              const comment = recentComments[j];
              sendUserEvent(userId, {
                type: 'comment',
                text: `${comment.text}\n@${comment.username}\n${comment.relativeTime}`,
                url: `https://www.tiktok.com/@${comment.username}`
              });
            }
            
            // Send post header (LAST, so it appears first when UI reverses)
            sendUserEvent(userId, {
              type: 'post-header',
              text: post.username,
              url: post.videoUrl
            });
          }
        }
        
      } catch (error) {
        console.error(`[TikTok Search Worker] Error processing account ${account.id}:`, error);
        
        // Send user-friendly error messages
        if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
          sendUserEvent(userId, { 
            type: 'error', 
            text: `⚠️ Chrome not running! Please run launch-chrome.bat and keep it open.` 
          });
        } else if (error instanceof Error && error.message.includes('not ready')) {
          sendUserEvent(userId, { 
            type: 'error', 
            text: `Account not ready - please complete setup first` 
          });
        } else {
          sendUserEvent(userId, { 
            type: 'error', 
            text: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
          });
        }
        // Continue with next account
      }
    }
    
    console.log('[TikTok Search Worker] Search completed');
    
    // Send completion message
    sendUserEvent(userId, { 
      type: 'info', 
      text: '✅ Search completed for all accounts' 
    });
    
  } catch (error) {
    console.error('[TikTok Search Worker] Error:', error);
  } finally {
    connection.release();
  }
}

/**
 * Run TikTok search for all active accounts (backward compatibility)
 * This searches for all users' accounts
 */
export async function runTikTokSearchForAllAccounts() {
  const connection = await db.getConnection();
  try {
    // Get all unique user IDs with active accounts
    const [users] = await connection.query(
      'SELECT DISTINCT user_id FROM tiktok_accounts WHERE is_active = 1'
    );
    
    for (const user of users as any[]) {
      await runTikTokSearchForAccounts(user.user_id);
    }
  } catch (error) {
    console.error('[TikTok Search Worker] Error in runTikTokSearchForAllAccounts:', error);
  } finally {
    connection.release();
  }
}

// Start periodic search worker (runs every 15 minutes)
export function startTikTokSearchWorker() {
  console.log('[TikTok Search Worker] Initialized - will run when triggered from dashboard');
  
  // Don't run automatically - wait for manual trigger from dashboard
  // Users will click "Start" button to initiate search
}
