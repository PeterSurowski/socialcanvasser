import puppeteer from 'puppeteer-core';
import db from '../config/database.js';

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
 * Search TikTok for ONE keyword at a time (realistic usage pattern)
 * Returns posts found and the next keyword index to use
 */
export async function searchTikTokByKeywords(
  accountId: number, 
  keywords: string[], 
  keywordIndex: number = 0
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
    
    // Handle different session types: cookies or container
    let browser: any;
    let page: any;
    
    if (sessionData.type === 'cookies' && sessionData.cookies && Array.isArray(sessionData.cookies)) {
      // Cookie-based authentication (manual desktop login)
      // BUT: If there's also a debugPort, it means this is actually a container
      // and we should skip cookie injection (container has persistent profile)
      
      if (sessionData.debugPort) {
        console.log(`[TikTok Search] Account ${accountId} has cookies AND container - using container session (no cookie injection)`);
        
        browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${sessionData.debugPort}`,
          protocolTimeout: 120000 // 2 minutes instead of default 30 seconds
        });
        
        page = await browser.newPage();
        
      } else {
        // Pure cookie-based: no container, need to inject cookies
        console.log(`[TikTok Search] Using imported cookies for account ${accountId}`);
        console.error(`[TikTok Search] ⚠️ WARNING: Cookie-based auth without container not yet implemented`);
        throw new Error('Cookie-only authentication requires a browser to connect to');
      }
      
    } else if (sessionData.debugPort) {
      // Container-based authentication (popup login)
      console.log(`[TikTok Search] Connecting to container for account ${accountId} on port ${sessionData.debugPort}`);
      
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${sessionData.debugPort}`,
        protocolTimeout: 120000 // 2 minutes instead of default 30 seconds
      });
      
      page = await browser.newPage();
      
    } else {
      throw new Error(`No valid authentication method found for account ${accountId}`);
    }
    
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
      
      // Debug: take screenshot to see what's on the page
      try {
        await page.screenshot({ path: `/tmp/tiktok_search_${keyword}_${Date.now()}.png` });
        console.log(`[TikTok Search] Screenshot saved for debugging`);
      } catch (e) {
        console.log(`[TikTok Search] Could not save screenshot`);
      }
      
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
      
      // Additional wait for actual video items to appear
      await page.waitForSelector('[data-e2e="search-video-item"]', { timeout: 10000 }).catch(() => {
        console.log(`[TikTok Search] No video items found for keyword: ${keyword}`);
      });
      
      // Debug: check what's actually on the page
      let pageInfo;
      try {
        pageInfo = await page.evaluate(() => {
          const bodyText = document.body.innerText.substring(0, 500);
          const videoItems = document.querySelectorAll('[data-e2e="search-video-item"]').length;
          const allDataE2e = Array.from(document.querySelectorAll('[data-e2e]')).map(el => el.getAttribute('data-e2e')).slice(0, 20);
          const isLoginPrompt = bodyText.includes('Log in') || bodyText.includes('Use QR code') || bodyText.includes('Use phone / email');
          const isErrorPage = bodyText.includes('Page not available') || bodyText.includes('Sorry about that');
          return { bodyText, videoItems, allDataE2e, isLoginPrompt, isErrorPage };
        });
      } catch (evalError) {
        console.log(`[TikTok Search] Could not evaluate page for keyword: ${keyword} - skipping`);
        continue; // Skip this keyword
      }
      
      console.log(`[TikTok Search] Found ${pageInfo.videoItems} video items`);
      
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
      
      if (pageInfo.videoItems === 0) {
        console.log(`[TikTok Search] Available data-e2e attributes: ${pageInfo.allDataE2e.join(', ')}`);
        console.log(`[TikTok Search] Page content preview: ${pageInfo.bodyText.substring(0, 200)}`);
      }
      
      // Extract post data
      let posts = [];
      try {
        posts = await page.evaluate(() => {
        const items = document.querySelectorAll('[data-e2e="search-video-item"]');
        const results: any[] = [];
        
        items.forEach((item, index) => {
          if (index >= 10) return; // Limit to 10 posts per keyword
          
          try {
            // Extract username
            const usernameEl = item.querySelector('[data-e2e="search-card-user-link"]');
            const username = usernameEl?.textContent?.trim() || '';
            
            // Extract caption
            const captionEl = item.querySelector('[data-e2e="search-card-desc"]');
            const caption = captionEl?.textContent?.trim() || '';
            
            // Extract video URL
            const linkEl = item.querySelector('a[href*="/video/"]');
            const videoUrl = linkEl?.getAttribute('href') || '';
            
            // Extract engagement metrics (these selectors may need adjustment)
            const likesEl = item.querySelector('[data-e2e="search-card-like-count"]');
            const likes = parseInt(likesEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
            
            const commentsEl = item.querySelector('[data-e2e="search-card-comment-count"]');
            const comments = parseInt(commentsEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
            
            results.push({
              username,
              caption,
              videoUrl: videoUrl.startsWith('http') ? videoUrl : `https://www.tiktok.com${videoUrl}`,
              likes,
              comments,
              shares: 0, // TikTok doesn't always show share count in search
              timestamp: new Date()
            });
          } catch (err) {
            console.error('Error extracting post data:', err);
          }
        });
        
        return results;
      });
      } catch (extractError) {
        console.log(`[TikTok Search] Could not extract posts for keyword: ${keyword} - timeout or error`);
        posts = []; // Empty array if extraction fails
      }
      
      if (posts.length > 0) {
        console.log(`[TikTok Search] Extracted ${posts.length} posts for keyword: ${keyword}`);
      }
      
      foundPosts.push(...posts);
    
    await browser.disconnect();
    
    console.log(`[TikTok Search] Found ${foundPosts.length} posts for account ${accountId}`);
    
    return { posts: foundPosts, nextKeywordIndex };
    
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
      'SELECT keywords FROM user_config WHERE user_id = ?',
      [userId]
    );
    
    if (!configRows || (configRows as any[]).length === 0) {
      console.log('[TikTok Search Worker] No keywords configured');
      return;
    }
    
    const keywordsStr = (configRows as any[])[0].keywords || '';
    const keywords = keywordsStr.split(',').map((k: string) => k.trim()).filter((k: string) => k);
    
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
        const result = await searchTikTokByKeywords(account.id, keywords, keywordIndex);
        
        // Store posts in database
        for (const post of result.posts) {
          await connection.query(
            `INSERT INTO tiktok_posts (account_id, username, caption, video_url, likes, comments, shares, found_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE likes = VALUES(likes), comments = VALUES(comments)`,
            [account.id, post.username, post.caption, post.videoUrl, post.likes, post.comments, post.shares, post.timestamp]
          );
        }
        
        // Update last_keyword_index and last_search_at for rotation
        await connection.query(
          'UPDATE tiktok_accounts SET last_keyword_index = ?, last_search_at = NOW() WHERE id = ?',
          [result.nextKeywordIndex, account.id]
        );
        
        console.log(`[TikTok Search Worker] Stored ${result.posts.length} posts for account ${account.id}`);
        console.log(`[TikTok Search Worker] Next search will use keyword index ${result.nextKeywordIndex}`);
        
      } catch (error) {
        console.error(`[TikTok Search Worker] Error processing account ${account.id}:`, error);
        // Continue with next account
      }
    }
    
    console.log('[TikTok Search Worker] Search completed');
    
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
