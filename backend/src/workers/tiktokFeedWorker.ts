/**
 * TikTok Feed Worker - Scrape from For You feed instead of search
 * Search is heavily rate-limited, but the main feed is more accessible
 */

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
 * Scrape TikTok "For You" feed and filter by keywords
 * This is less likely to trigger rate limits than search
 */
export async function scrapeTikTokFeed(accountId: number, keywords: string[], maxPosts: number = 20) {
  const connection = await db.getConnection();
  
  try {
    // Get account session data
    const [rows] = await connection.query(
      'SELECT session_data FROM tiktok_accounts WHERE id = ?',
      [accountId]
    );
    
    if (!rows || (rows as any[]).length === 0) {
      throw new Error(`Account ${accountId} not found`);
    }
    
    const sessionData = JSON.parse((rows as any[])[0].session_data);
    
    let browser;
    let page;
    
    // Connect to container browser
    if (!sessionData.debugPort) {
      throw new Error(`No debugPort found for account ${accountId}`);
    }
    
    console.log(`[TikTok Feed] Connecting to container for account ${accountId} on port ${sessionData.debugPort}`);
    
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${sessionData.debugPort}`,
      protocolTimeout: 120000
    });
    
    page = await browser.newPage();
    
    // Navigate to TikTok homepage (For You feed)
    console.log(`[TikTok Feed] Navigating to For You feed...`);
    await page.goto('https://www.tiktok.com/foryou', {
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch(() => {
      console.log(`[TikTok Feed] Navigation timeout, continuing...`);
    });
    
    await page.waitForTimeout(3000); // Wait for initial posts to load
    
    const foundPosts: TikTokPost[] = [];
    let scrollAttempts = 0;
    const maxScrolls = 10; // Limit scrolling to avoid detection
    
    console.log(`[TikTok Feed] Scrolling feed and filtering by keywords: ${keywords.join(', ')}`);
    
    while (foundPosts.length < maxPosts && scrollAttempts < maxScrolls) {
      scrollAttempts++;
      
      // Extract posts from current viewport
      const posts = await page.evaluate((kw) => {
        const results: any[] = [];
        
        // TikTok feed uses different selectors than search
        const items = document.querySelectorAll('[data-e2e="recommend-list-item"]');
        
        items.forEach((item) => {
          try {
            // Extract caption
            const captionEl = item.querySelector('[data-e2e="video-desc"]');
            const caption = captionEl?.textContent?.trim() || '';
            
            // Check if caption contains any keyword (case-insensitive)
            const containsKeyword = kw.some(keyword => 
              caption.toLowerCase().includes(keyword.toLowerCase())
            );
            
            if (!containsKeyword) return;
            
            // Extract username
            const usernameEl = item.querySelector('[data-e2e="video-author-uniqueid"]');
            const username = usernameEl?.textContent?.trim() || '';
            
            // Extract video URL
            const linkEl = item.querySelector('a[href*="/video/"]');
            const videoUrl = linkEl?.getAttribute('href') || '';
            
            // Extract engagement (might not be visible in feed)
            const likes = 0; // Feed doesn't always show engagement
            const comments = 0;
            
            if (username && caption && videoUrl) {
              results.push({
                username,
                caption,
                videoUrl: videoUrl.startsWith('http') ? videoUrl : `https://www.tiktok.com${videoUrl}`,
                likes,
                comments,
                shares: 0,
                timestamp: new Date()
              });
            }
          } catch (err) {
            // Skip this post
          }
        });
        
        return results;
      }, keywords);
      
      // Add new posts (avoid duplicates)
      for (const post of posts) {
        if (!foundPosts.some(p => p.videoUrl === post.videoUrl)) {
          foundPosts.push(post);
          console.log(`[TikTok Feed] Found post from @${post.username}: ${post.caption.substring(0, 50)}...`);
        }
      }
      
      if (foundPosts.length >= maxPosts) {
        break;
      }
      
      // Scroll down to load more posts
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      
      // Random delay between scrolls
      await page.waitForTimeout(2000 + Math.random() * 2000);
    }
    
    await browser.disconnect();
    
    console.log(`[TikTok Feed] Found ${foundPosts.length} posts matching keywords for account ${accountId}`);
    
    return foundPosts;
    
  } catch (error) {
    console.error(`[TikTok Feed] Error scraping feed for account ${accountId}:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Run feed scraping for a specific user's accounts
 */
export async function runTikTokFeedForAccounts(userId: number) {
  const connection = await db.getConnection();
  
  try {
    console.log(`[TikTok Feed Worker] Starting feed scrape for user ${userId} accounts...`);
    
    // Get user's active TikTok accounts
    const [accounts] = await connection.query(
      'SELECT id FROM tiktok_accounts WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    
    if (!accounts || (accounts as any[]).length === 0) {
      console.log('[TikTok Feed Worker] No active accounts found');
      return;
    }
    
    // Get user's keywords
    const [configRows] = await connection.query(
      'SELECT keywords FROM user_config WHERE user_id = ?',
      [userId]
    );
    
    if (!configRows || (configRows as any[]).length === 0) {
      console.log('[TikTok Feed Worker] No keywords configured');
      return;
    }
    
    const keywordsStr = (configRows as any[])[0].keywords || '';
    const keywords = keywordsStr.split(',').map((k: string) => k.trim()).filter((k: string) => k);
    
    if (keywords.length === 0) {
      console.log('[TikTok Feed Worker] No valid keywords found');
      return;
    }
    
    // Scrape feed for each account
    for (const account of accounts as any[]) {
      try {
        const posts = await scrapeTikTokFeed(account.id, keywords, 20);
        
        // Store posts in database
        for (const post of posts) {
          await connection.query(
            `INSERT INTO tiktok_posts (account_id, username, caption, video_url, likes, comments, shares, found_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE likes = VALUES(likes), comments = VALUES(comments)`,
            [account.id, post.username, post.caption, post.videoUrl, post.likes, post.comments, post.shares, post.timestamp]
          );
        }
        
        console.log(`[TikTok Feed Worker] Stored ${posts.length} posts for account ${account.id}`);
        
      } catch (error) {
        console.error(`[TikTok Feed Worker] Error processing account ${account.id}:`, error);
      }
    }
    
    console.log('[TikTok Feed Worker] Feed scrape completed');
    
  } catch (error) {
    console.error('[TikTok Feed Worker] Error:', error);
  } finally {
    connection.release();
  }
}
