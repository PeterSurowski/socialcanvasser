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

export async function searchTikTokByKeywords(accountId: number, keywords: string[]): Promise<TikTokPost[]> {
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
    
    // Connect to the container's Chrome via DevTools
    if (!sessionData.debugPort) {
      throw new Error(`No debugPort found for account ${accountId}`);
    }
    
    console.log(`[TikTok Search] Connecting to account ${accountId} on port ${sessionData.debugPort}`);
    
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${sessionData.debugPort}`
    });
    
    const page = await browser.newPage();
    
    const foundPosts: TikTokPost[] = [];
    
    // Search for each keyword
    for (const keyword of keywords) {
      console.log(`[TikTok Search] Searching for keyword: ${keyword}`);
      
      // Navigate to TikTok search
      await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Wait for posts to load
      await page.waitForSelector('[data-e2e="search-video-item"]', { timeout: 10000 }).catch(() => {
        console.log(`[TikTok Search] No results found for keyword: ${keyword}`);
      });
      
      // Extract post data
      const posts = await page.evaluate(() => {
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
      
      foundPosts.push(...posts);
      
      // Small delay between keyword searches
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    await browser.disconnect();
    
    console.log(`[TikTok Search] Found ${foundPosts.length} posts for account ${accountId}`);
    
    return foundPosts;
    
  } catch (error) {
    console.error(`[TikTok Search] Error searching for account ${accountId}:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

// Run search for all active accounts
export async function runTikTokSearchForAllAccounts() {
  const connection = await db.getConnection();
  
  try {
    console.log('[TikTok Search Worker] Starting search for all accounts...');
    
    // Get all active TikTok accounts
    const [accounts] = await connection.query(
      'SELECT id FROM tiktok_accounts WHERE is_active = 1'
    );
    
    if (!accounts || (accounts as any[]).length === 0) {
      console.log('[TikTok Search Worker] No active accounts found');
      return;
    }
    
    // Get user's keywords from config
    // For now, we'll use a simple approach - get keywords from the first user's config
    // In production, you'd match accounts to their user's keywords
    const [configRows] = await connection.query(
      'SELECT keywords FROM user_config LIMIT 1'
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
    
    console.log(`[TikTok Search Worker] Searching for keywords: ${keywords.join(', ')}`);
    
    // Search for each account
    for (const account of accounts as any[]) {
      try {
        const posts = await searchTikTokByKeywords(account.id, keywords);
        
        // Store posts in database (you'll need to create a tiktok_posts table)
        for (const post of posts) {
          await connection.query(
            `INSERT INTO tiktok_posts (account_id, username, caption, video_url, likes, comments, shares, found_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE likes = VALUES(likes), comments = VALUES(comments)`,
            [account.id, post.username, post.caption, post.videoUrl, post.likes, post.comments, post.shares, post.timestamp]
          );
        }
        
        console.log(`[TikTok Search Worker] Stored ${posts.length} posts for account ${account.id}`);
        
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

// Start periodic search worker (runs every 15 minutes)
export function startTikTokSearchWorker() {
  console.log('[TikTok Search Worker] Starting periodic search worker...');
  
  // Run immediately on startup
  runTikTokSearchForAllAccounts().catch(err => {
    console.error('[TikTok Search Worker] Initial run failed:', err);
  });
  
  // Then run every 15 minutes
  setInterval(() => {
    runTikTokSearchForAllAccounts().catch(err => {
      console.error('[TikTok Search Worker] Scheduled run failed:', err);
    });
  }, 15 * 60 * 1000);
}
