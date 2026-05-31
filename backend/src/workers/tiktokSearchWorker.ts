import puppeteer from 'puppeteer-core';
import db from '../config/database.js';
import { sendUserEvent } from '../events/broadcaster.js';
import { analyzeCommentsForBuyingIntent } from '../services/openai.js';
import { engageWithUser } from '../services/engagement.js';
import { connectBrowserForAccount, closeBrowserConnection, switchToAccount, type BrowserConnection, type TikTokAccount } from '../services/browserManager.js';
import type { Page } from 'puppeteer-core';

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
 * Send a DM to the creator of the video
 * Returns true if successful, false if failed (but doesn't throw)
 */
async function sendDMToCreator(
  page: Page,
  videoUrl: string,
  userId: number,
  accountId: number,
  creatorMessage: string | null
): Promise<{ success: boolean; username?: string; error?: string }> {
  // Skip if no creator message configured
  if (!creatorMessage || creatorMessage.trim() === '') {
    console.log(`[DM Creator] No creator message configured, skipping DM to creator`);
    return { success: false, error: 'No creator message configured' };
  }
  
  console.log(`[DM Creator] Starting DM send process for ${videoUrl}`);
  
  try {
    // Extract creator username from page
    const creatorInfo = await page.evaluate(() => {
      // Try multiple selectors to find the username element
      let usernameEl = document.querySelector('[data-e2e="browse-username"]') ||
                       document.querySelector('[data-e2e="creator-nickname"]');
      
      // If not found, look for profile link near the video content (not in navigation)
      if (!usernameEl) {
        const profileLinks = Array.from(document.querySelectorAll('a[href^="/@"]'));
        // Filter to find the one that's the video creator (exclude navigation and sidebar)
        usernameEl = profileLinks.find(el => {
          const href = el.getAttribute('href') || '';
          if (!href.startsWith('/@') || href.includes('?')) return false;
          
          // Exclude navigation elements (check if inside nav or header)
          const isInNav = el.closest('nav, header, [role="navigation"]');
          if (isInNav) return false;
          
          // The creator link should have visible text
          const hasText = el.textContent?.trim();
          if (!hasText) return false;
          
          // Prefer elements with TikTok's typical creator link classes or near video player
          const isNearVideo = el.closest('[data-e2e="browse-video"], [id*="VideoContainer"]');
          return !!isNearVideo;
        }) || profileLinks.find(el => {
          // Fallback: just find first non-navigation profile link with text
          const href = el.getAttribute('href') || '';
          const isInNav = el.closest('nav, header, [role="navigation"]');
          return href.startsWith('/@') && !href.includes('?') && el.textContent?.trim() && !isInNav;
        });
      }
      
      let username = '';
      let profileLink = '';
      
      if (usernameEl) {
        // Get username from text content (may have whitespace/newlines)
        username = usernameEl.textContent?.trim().replace('@', '') || '';
        
        // If text extraction failed, try to get username from href attribute
        if (!username && usernameEl instanceof HTMLAnchorElement) {
          const href = usernameEl.getAttribute('href') || '';
          const match = href.match(/\/@([^/?]+)/);
          if (match) {
            username = match[1];
          }
        }
        
        profileLink = usernameEl instanceof HTMLAnchorElement ? usernameEl.href : '';
      }
      
      return { username, profileLink, foundElement: !!usernameEl };
    });
    
    console.log(`[DM Creator] Found element: ${creatorInfo.foundElement}, Username: "${creatorInfo.username}", Link: ${creatorInfo.profileLink}`);
    
    // Fallback: Extract username from video URL (most reliable method)
    // Video URL format: https://www.tiktok.com/@username/video/123456789
    let finalUsername = creatorInfo.username;
    const urlMatch = videoUrl.match(/\/@([^/?]+)/);
    if (urlMatch && urlMatch[1]) {
      const usernameFromUrl = urlMatch[1];
      console.log(`[DM Creator] Username from URL: "${usernameFromUrl}"`);
      
      // If we found a username from the page but it doesn't match the URL, use URL version
      if (finalUsername && finalUsername.toLowerCase() !== usernameFromUrl.toLowerCase()) {
        console.log(`[DM Creator] ⚠️ Page username "${finalUsername}" doesn't match URL username "${usernameFromUrl}" - using URL version`);
        finalUsername = usernameFromUrl;
      } else if (!finalUsername) {
        // No username found on page, use URL version
        console.log(`[DM Creator] Using username from URL as fallback`);
        finalUsername = usernameFromUrl;
      }
    }
    
    if (!finalUsername) {
      console.log(`[DM Creator] ⚠️ Could not find creator username`);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ Could not find creator username` });
      return { success: false, error: 'Username not found' };
    }
    
    console.log(`[DM Creator] Creator: @${finalUsername}`);
    sendUserEvent(userId, { type: 'info', text: `📨 Sending DM to @${finalUsername}...` });
    
    // Navigate directly to the creator's profile using the URL (most reliable)
    console.log(`[DM Creator] Navigating to profile...`);
    const profileUrl = `https://www.tiktok.com/@${finalUsername}`;
    try {
      await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      console.log(`[DM Creator] Navigated to ${profileUrl}`);
    } catch (navError) {
      console.log(`[DM Creator] ⚠️ Could not navigate to profile: ${navError}`);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ Could not navigate to creator profile` });
      return { success: false, username: finalUsername, error: 'Profile navigation failed' };
    }
    
    // Wait for profile page to fully render with generous timeout
    try {
      await page.waitForSelector('[data-e2e="user-page"], [data-e2e="user-post-item"]', { timeout: 15000 });
      console.log(`[DM Creator] Profile page loaded`);
    } catch (waitError) {
      console.log(`[DM Creator] ⚠️ Profile elements didn't load - may be restricted or bot-detected`);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ Could not access @${finalUsername}'s profile` });
      return { success: false, username: finalUsername, error: 'Profile elements not found' };
    }
    
    // Look for the Message button (use data-e2e attribute to avoid navigation button)
    const messageButtonFound = await page.evaluate(() => {
      // Try data-e2e attribute first (most reliable)
      let messageButton = document.querySelector('[data-e2e="message-button"]') as HTMLElement;
      
      // Fallback: look for button with "Message" text (singular, not "Messages" which is navigation)
      if (!messageButton) {
        const buttons = Array.from(document.querySelectorAll('button'));
        messageButton = buttons.find(btn => {
          const text = btn.textContent?.trim() || '';
          // Match "Message" but NOT "Messages" (navigation button)
          return text === 'Message' || text.toLowerCase() === 'message';
        }) as HTMLElement;
      }
      
      if (messageButton) {
        messageButton.click();
        return true;
      }
      return false;
    });
    
    if (!messageButtonFound) {
      console.log(`[DM Creator] ⚠️ Message button not found - DMs may be disabled for this user`);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ @${finalUsername} has DMs disabled` });
      
      // Return to video page
      await page.goBack();
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return { success: false, username: finalUsername, error: 'Message button not found' };
    }
    
    console.log(`[DM Creator] Message button clicked, waiting for chat interface...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Wait for the message input box to appear (TikTok uses Draft.js contenteditable)
    console.log(`[DM Creator] Waiting for DM compose box...`);
    try {
      await page.waitForSelector('.public-DraftEditor-content[contenteditable="true"], [contenteditable="true"]', {
        timeout: 13000,
        visible: true
      });
      console.log(`[DM Creator] Chat interface loaded`);
    } catch (waitError) {
      console.log(`[DM Creator] ⚠️ Timeout waiting for DM compose box`);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ DM compose box did not load` });
      
      // Return to video page
      await page.goBack();
      await new Promise(resolve => setTimeout(resolve, 1000));
      const currentUrl = page.url();
      if (!currentUrl.includes('/video/')) {
        await page.goBack();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      return { success: false, username: finalUsername, error: 'Message input not found' };
    }
    
    // CRITICAL: Click the input to focus it, then use page.type() to simulate human typing
    console.log(`[DM Creator] Clicking input to focus...`);
    try {
      await page.click('.public-DraftEditor-content[contenteditable="true"]');
    } catch (clickErr) {
      // Try generic contenteditable as fallback
      await page.click('[contenteditable="true"]');
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Type the message using page.type() with delay (simulates human typing, makes Send button appear)
    console.log(`[DM Creator] Typing message (${creatorMessage.length} characters)...`);
    try {
      await page.type('.public-DraftEditor-content[contenteditable="true"]', creatorMessage, {
        delay: 10 // Small delay between keystrokes to simulate human typing
      });
    } catch (typeErr) {
      // Try generic contenteditable as fallback
      const contentEditables = await page.$$('[contenteditable="true"]');
      if (contentEditables.length > 0) {
        await contentEditables[0].type(creatorMessage, { delay: 10 });
      } else {
        throw typeErr;
      }
    }
    
    console.log(`[DM Creator] ✅ Message typed successfully!`);
    
    // CRITICAL: Send button only appears AFTER text is entered
    console.log(`[DM Creator] Waiting for Send button to appear...`);
    try {
      await page.waitForSelector('[data-e2e="message-send"], [data-e2e="dm-new-send-btn"]', {
        timeout: 5000,
        visible: true
      });
      console.log(`[DM Creator] ✅ Send button appeared!`);
    } catch (waitError) {
      console.log(`[DM Creator] ⚠️ Send button did not appear after typing`);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ Send button did not appear` });
      
      // Return to video page
      await page.goBack();
      await new Promise(resolve => setTimeout(resolve, 1000));
      const currentUrl = page.url();
      if (!currentUrl.includes('/video/')) {
        await page.goBack();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      return { success: false, username: finalUsername, error: 'Send button did not appear' };
    }
    
    // Click the send button
    console.log(`[DM Creator] Clicking Send button...`);
    try {
      await page.click('[data-e2e="message-send"], [data-e2e="dm-new-send-btn"]');
      console.log(`[DM Creator] ✅ Send button clicked!`);
    } catch (clickError) {
      console.log(`[DM Creator] ❌ Failed to click Send button:`, clickError);
      sendUserEvent(userId, { type: 'warning', text: `⚠️ Failed to click Send button` });
      
      // Return to video page
      await page.goBack();
      await new Promise(resolve => setTimeout(resolve, 1000));
      const currentUrl = page.url();
      if (!currentUrl.includes('/video/')) {
        await page.goBack();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      return { success: false, username: finalUsername, error: 'Failed to click Send button' };
    }
    
    console.log(`[DM Creator] ✅ Message sent successfully!`);
    sendUserEvent(userId, { type: 'success', text: `✅ DM sent to @${finalUsername}` });
    
    // Wait a moment for the message to send
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Log the activity
    try {
      const connection = await db.getConnection();
      await connection.query(
        `INSERT INTO activity_logs (user_id, tiktok_account_id, action_type, target_user, post_url, success, created_at, date)
         VALUES (?, ?, 'dm_sent', ?, ?, 1, NOW(), CURDATE())`,
        [userId, accountId, finalUsername, videoUrl]
      );
      connection.release();
      console.log(`[DM Creator] Activity logged`);
    } catch (logError) {
      console.error(`[DM Creator] Failed to log activity:`, logError);
    }
    
    // Return to the video page
    console.log(`[DM Creator] Returning to video...`);
    await page.goBack(); // Back from chat
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if we're on the profile page or video page
    const currentUrl = page.url();
    if (!currentUrl.includes('/video/')) {
      console.log(`[DM Creator] Still on profile, going back once more...`);
      await page.goBack(); // Back from profile
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Verify we're back on the video page
    const finalUrl = page.url();
    if (finalUrl.includes('/video/')) {
      console.log(`[DM Creator] ✅ Successfully returned to video: ${finalUrl}`);
    } else {
      console.log(`[DM Creator] ⚠️ Not on video page, navigating directly...`);
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return { success: true, username: finalUsername };
    
  } catch (error) {
    console.error(`[DM Creator] Error sending DM:`, error);
    sendUserEvent(userId, { 
      type: 'warning', 
      text: `⚠️ Failed to send DM: ${error instanceof Error ? error.message : 'Unknown error'}` 
    });
    
    // Try to return to video page
    try {
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (navError) {
      console.error(`[DM Creator] Failed to return to video:`, navError);
    }
    
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
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
  userConfig?: any,
  getUserConfigForAccount?: (account: any) => Promise<any | null>,
  getBrowserContextForAccount?: (account: any) => Promise<{ context: any, page: any }>,
  existingPage?: any,
  checkpoint?: AutomationCheckpoint | null,
  commentRateLimitTracker?: Map<number, number>
): Promise<{ posts: TikTokPost[], nextKeywordIndex: number }> {
  const connection = await db.getConnection();
  
  try {
    // PHASE 3: Track current account (may change during rotation)
    let currentAccountId = accountId;
    
    // Get account info (including browser type and profile)
    const [rows] = await connection.query(
      'SELECT id, account_identifier, browser_type, incogniton_profile_id, session_data, group_id FROM tiktok_accounts WHERE id = ? AND is_active = 1 LIMIT 1',
      [accountId]
    );
    
    if (!rows || (rows as any[]).length === 0) {
      throw new Error(`Account ${accountId} not found or inactive`);
    }
    
    const account = (rows as any[])[0] as TikTokAccount;
    const sessionData = JSON.parse(account.session_data || '{}');
    
    // Verify Chrome is running (for legacy chrome_debug mode only)
    if (account.browser_type === 'chrome_debug' && !sessionData.ready) {
      throw new Error(`Account ${accountId} not ready - user must launch Chrome and login first`);
    }
    
    // Use existing page if provided, otherwise connect to browser
    let page: any;
    let browserConnection: any = null;
    let shouldCloseBrowser = false;
    
    if (existingPage) {
      console.log(`[TikTok Search] Using existing page for account ${accountId}`);
      page = existingPage;
    } else {
      console.log(`[TikTok Search] Connecting browser for account ${accountId} (${account.browser_type})...`);
      browserConnection = await connectBrowserForAccount(account);
      page = browserConnection.page;
      shouldCloseBrowser = true; // We opened it, so we should close it
    }
    
    const foundPosts: TikTokPost[] = [];
    
    // ONLY SEARCH ONE KEYWORD to avoid bot detection
    // Rotate through keywords on subsequent searches
    const keyword = keywords[keywordIndex % keywords.length];
    const nextKeywordIndex = (keywordIndex + 1) % keywords.length;
    
    console.log(`[TikTok Search] Searching for keyword: "${keyword}" (index ${keywordIndex}/${keywords.length - 1})`);
    
    const accountGroupId = Number((account as any).group_id || 0);
    const checkpointGroupId = Number(checkpoint?.groupId || 0);
    const isCheckpointGroupMatch = !!(checkpointGroupId && accountGroupId && checkpointGroupId === accountGroupId);
    const shouldResume = !!(
      checkpoint &&
      checkpoint.keywordIndex === keywordIndex &&
      (checkpoint.accountId === accountId || isCheckpointGroupMatch)
    );
    const resumeVideoIndex = shouldResume ? (checkpoint?.videoIndex ?? 0) : 0;
    const resumeVideoUrl = shouldResume ? (checkpoint?.videoUrl ?? null) : null;
    const resumeStage = shouldResume ? (checkpoint?.stage ?? null) : null;
    const resumeEngagementIndex = shouldResume ? (checkpoint?.engagementIndex ?? 0) : 0;
    
    if (userId) {
      await updateAutomationCheckpoint(userId, {
        accountId,
        keywordIndex,
        videoIndex: resumeVideoIndex,
        videoUrl: resumeVideoUrl,
        stage: 'search',
        engagementIndex: 0,
        engagementUsername: null
      });
    }
    
    try {
      // First, check current page URL
      const currentUrl = page.url();
      console.log(`[TikTok Search] Current page URL before navigation: ${currentUrl}`);
      
      // Navigate to TikTok search
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
      console.log(`[TikTok Search] Navigating to: ${searchUrl}`);
      
      try {
        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded', // Less strict than networkidle2
          timeout: 60000 // Increase timeout to 60 seconds
        });
        console.log(`[TikTok Search] Navigation successful`);
      } catch (gotoError) {
        console.error(`[TikTok Search] Navigation failed:`, gotoError);
        // Try alternative navigation method
        console.log(`[TikTok Search] Trying alternative navigation method...`);
        await page.evaluate((url) => {
          window.location.href = url;
        }, searchUrl);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {
          console.log(`[TikTok Search] Alternative navigation also timed out, checking page state...`);
        });
      }
      
      // Wait a moment for page to settle
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Now clear TikTok's cache/state to prevent cached search results
      console.log(`[TikTok Search] Clearing TikTok cache for fresh results...`);
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.clear();
      });
      
      // Reload with cache-busting timestamp
      const timestamp = Date.now();
      const freshUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=${timestamp}`;
      console.log(`[TikTok Search] Reloading with cache-buster: ${freshUrl}`);
      await page.goto(freshUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      
    } catch (navError) {
      console.error(`[TikTok Search] Navigation error for keyword: ${keyword}`, navError);
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
      
      // SCROLL SEARCH RESULTS TO LOAD MORE VIDEOS (target: 200 videos or all available)
      console.log(`[TikTok Search] 📜 Scrolling search results to load more videos...`);
      try {
        // Get search results container and initial video count
        const scrollInfo = await page.evaluate(() => {
          // Count initial videos
          const initialItems = document.querySelectorAll('[data-e2e="search_top-item"]');
          const initialCount = initialItems.length;
          
          // Find scrollable container (the main search results list)
          const containers = Array.from(document.querySelectorAll('[data-e2e="search_top-item-list"], [class*="DivItemContainer"], main, [role="main"]'));
          
          console.log(`[Browser] Found ${containers.length} potential scroll containers`);
          
          const container = containers.find(el => {
            const rect = el.getBoundingClientRect();
            const hasGoodDimensions = rect.width > 300 && rect.height > 300;
            
            if (hasGoodDimensions) {
              console.log(`[Browser] Container candidate:`, {
                tag: el.tagName,
                class: el.className.substring(0, 50),
                width: rect.width,
                height: rect.height
              });
            }
            
            return hasGoodDimensions;
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
              containerTag: container.tagName,
              containerClass: container.className.substring(0, 60)
            };
          }
          
          return { found: false, initialCount };
        });
        
        console.log(`[TikTok Search] 📊 Initial videos loaded: ${scrollInfo.initialCount}`);
        
        if (scrollInfo.found) {
          console.log(`[TikTok Search] ✅ Scrollable container found: <${scrollInfo.containerTag}> ${scrollInfo.containerClass}...`);
          console.log(`[TikTok Search] 🖱️ Mouse position: (${Math.round(scrollInfo.x)}, ${Math.round(scrollInfo.y)})`);
          
          // Move mouse over search results container
          await page.mouse.move(scrollInfo.x, scrollInfo.y);
          console.log(`[TikTok Search] ✅ Mouse positioned over search results`);
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          let loadedVideos = scrollInfo.initialCount;
          let scrollAttempts = 0;
          const maxScrollAttempts = 50; // Safety limit
          const targetVideos = 200; // Target: 200 videos
          let noChangeCount = 0;
          
          while (loadedVideos < targetVideos && scrollAttempts < maxScrollAttempts) {
            scrollAttempts++;
            const beforeCount = loadedVideos;
            
            // Scroll down
            await page.mouse.wheel({ deltaY: 800 });
            
            // Wait 2s for TikTok lazy loading
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Count videos after scroll
            loadedVideos = await page.evaluate(() => {
              return document.querySelectorAll('[data-e2e="search_top-item"]').length;
            });
            
            const increased = loadedVideos > beforeCount;
            
            // Log every scroll to track progress
            if (scrollAttempts % 5 === 0 || increased || scrollAttempts <= 3) {
              console.log(`[TikTok Search] 📊 Scroll ${scrollAttempts}: ${beforeCount} → ${loadedVideos} videos ${increased ? '✅' : '⚠️'}`);
            }
            
            if (loadedVideos >= targetVideos) {
              console.log(`[TikTok Search] ✅ Reached target of ${targetVideos} videos! (loaded ${loadedVideos})`);
              break;
            }
            
            // Stop if no progress after 5 consecutive attempts
            if (!increased) {
              noChangeCount++;
              if (noChangeCount >= 5) {
                console.log(`[TikTok Search] ⚠️ No new videos after ${noChangeCount} scroll attempts - stopping at ${loadedVideos} videos (might be all available)`);
                break;
              }
            } else {
              noChangeCount = 0;
            }
          }
          
          if (scrollAttempts >= maxScrollAttempts) {
            console.log(`[TikTok Search] ⚠️ Reached max scroll attempts (${maxScrollAttempts}), proceeding with ${loadedVideos} videos`);
          }
          
          console.log(`[TikTok Search] ✅ Scrolling complete: loaded ${loadedVideos} videos in ${scrollAttempts} scroll attempts`);
        } else {
          console.log(`[TikTok Search] ⚠️ Could not find scrollable container, proceeding with initially loaded videos`);
        }
      } catch (scrollErr) {
        console.log(`[TikTok Search] ❌ Error during scroll:`, scrollErr);
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
        await closeBrowserConnection(browserConnection);
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
        // First, let's diagnose what's actually on the page
        const pageDiagnostics = await page.evaluate(() => {
          // Get the search query from the URL
          const urlParams = new URLSearchParams(window.location.search);
          const searchQuery = urlParams.get('q');
          
          // Get the page title
          const title = document.title;
          
          // Get the search input value (what TikTok thinks we searched for)
          const searchInput = document.querySelector('[data-e2e="search-user-input"]') as HTMLInputElement;
          const inputValue = searchInput?.value || '';
          
          // Check if there's a "No results" message
          const noResults = document.body.innerText.includes('No results found') || 
                           document.body.innerText.includes('No videos found');
          
          return { 
            urlQuery: searchQuery, 
            pageTitle: title, 
            searchInputValue: inputValue,
            noResults,
            currentUrl: window.location.href
          };
        });
        
        console.log(`[TikTok Search] 🔍 Page Diagnostics:`, pageDiagnostics);
        
        // Check if we're actually on a search results page with the right keyword
        if (!pageDiagnostics.currentUrl.includes('/search') || 
            !pageDiagnostics.urlQuery || 
            pageDiagnostics.urlQuery.toLowerCase() !== keyword.toLowerCase()) {
          console.log(`[TikTok Search] ⚠️ WARNING: Page URL doesn't match keyword!`);
          console.log(`[TikTok Search]   Expected keyword: "${keyword}"`);
          console.log(`[TikTok Search]   URL has: "${pageDiagnostics.urlQuery}"`);
        }
        
        // First, get all video elements from search results AND extract their URLs for verification
        const videoElements = await page.evaluate(() => {
          const debugInfo = {
            currentUrl: window.location.href,
            pageTitle: document.title,
            selectorUsed: '',
            itemsFound: 0,
            itemDetails: [] as string[],
            videoLinksCount: 0,
            results: [] as { index: number; href: string }[]
          };
          
          // TikTok's actual search results structure (based on real HTML):
          // Container: div[data-e2e="search_top-item-list"]
          // Items: div[data-e2e="search_top-item"]
          // Links: a[href*="/video/"] inside each item
          
          let items: Element[] = [];
          
          // PRIMARY: Look for search_top-item elements (the actual search results!)
          items = Array.from(document.querySelectorAll('[data-e2e="search_top-item"]'));
          if (items.length > 0) {
            debugInfo.selectorUsed = '[data-e2e="search_top-item"]';
            debugInfo.itemsFound = items.length;
            debugInfo.itemDetails = items.slice(0, 3).map((item, i) => {
              const link = item.querySelector('a[href*="/video/"]');
              const href = link?.getAttribute('href') || 'no link found';
              const isVisible = (item as HTMLElement).offsetParent !== null;
              return `Item ${i}: href=${href}, visible=${isVisible}`;
            });
          }
          
          // FALLBACK: If search_top-item not found, try other selectors
          if (items.length === 0) {
            const fallbackSelectors = [
              '[data-e2e="feed-video"]',
              'section[data-e2e="feed-video"]',
              '[data-e2e="search-video-item"]',
              'section[id^="media-card-"]',
              'div[id^="grid-item-container-"]'
            ];
            
            for (const selector of fallbackSelectors) {
              items = Array.from(document.querySelectorAll(selector));
              if (items.length > 0) {
                debugInfo.selectorUsed = selector;
                debugInfo.itemsFound = items.length;
                debugInfo.itemDetails = items.slice(0, 3).map((item, i) => {
                  return `Item ${i}: tagName=${item.tagName}, classes=${item.className.substring(0, 50)}`;
                });
                break;
              }
            }
          }
          
          // Extract video URLs from the found items (up to 200 max)
          debugInfo.results = items.slice(0, 200).map((item, index) => {
            const link = item.querySelector('a[href*="/video/"]');
            const href = link?.getAttribute('href') || 'unknown';
            return { index, href };
          }).filter(result => result.href !== 'unknown');
          
          return debugInfo;
        });
        
        // Deduplicate video URLs (TikTok search results can contain duplicates after scrolling)
        const originalLength = videoElements.results.length;
        const seenUrls = new Set<string>();
        const duplicateUrls: string[] = [];
        
        const uniqueResults = videoElements.results.filter(result => {
          if (seenUrls.has(result.href)) {
            duplicateUrls.push(result.href);
            return false;
          }
          seenUrls.add(result.href);
          return true;
        });
        
        videoElements.results = uniqueResults;
        
        if (duplicateUrls.length > 0) {
          console.log(`[TikTok Search] 🧹 Removed ${duplicateUrls.length} duplicate URLs:`);
          // Show which URLs were duplicated and how many times each
          const duplicateCounts = new Map<string, number>();
          duplicateUrls.forEach(url => {
            duplicateCounts.set(url, (duplicateCounts.get(url) || 0) + 1);
          });
          duplicateCounts.forEach((count, url) => {
            console.log(`  ${url} (appeared ${count + 1} times total)`);
          });
        }
        
        // Log debug info in Node.js terminal where we can see it
        console.log(`[EXTRACTION DEBUG] Current URL: ${videoElements.currentUrl}`);
        console.log(`[EXTRACTION DEBUG] Page title: ${videoElements.pageTitle}`);
        console.log(`[EXTRACTION DEBUG] Selector used: "${videoElements.selectorUsed}"`);
        console.log(`[EXTRACTION DEBUG] Items found: ${videoElements.itemsFound}`);
        if (videoElements.itemDetails.length > 0) {
          console.log(`[EXTRACTION DEBUG] Item details (first 3):`);
          videoElements.itemDetails.forEach(detail => console.log(`  ${detail}`));
        }
        if (videoElements.videoLinksCount > 0) {
          console.log(`[EXTRACTION DEBUG] Video links found in fallback: ${videoElements.videoLinksCount}`);
        }
        console.log(`[EXTRACTION DEBUG] Extracted ${videoElements.results.length} video URLs (after deduplication):`);
        videoElements.results.forEach((result, i) => {
          console.log(`  ${i + 1}. ${result.href}`);
        });
        
        console.log(`[TikTok Search] Found ${videoElements.results.length} videos from search results for keyword "${keyword}":`);
        videoElements.results.forEach((ve, i) => {
          console.log(`  ${i + 1}. ${ve.href}`);
        });
        
        // Send result count to Live Feed
        if (userId) {
          sendUserEvent(userId, { 
            type: 'info', 
            text: `🎯 ${videoElements.results.length} results found!` 
          });
        }
        
        let startIndex = 0;
        if (resumeVideoUrl) {
          const resumeIndex = videoElements.results.findIndex(result => {
            const url = result.href.startsWith('http') ? result.href : `https://www.tiktok.com${result.href}`;
            return url === resumeVideoUrl;
          });
          if (resumeIndex >= 0) {
            startIndex = resumeIndex;
          } else if (resumeVideoIndex) {
            startIndex = Math.min(resumeVideoIndex, videoElements.results.length - 1);
          }
        } else if (resumeVideoIndex) {
          startIndex = Math.min(resumeVideoIndex, videoElements.results.length - 1);
        }
        
        if (startIndex > 0) {
          console.log(`[TikTok Search] Resuming from video index ${startIndex + 1}/${videoElements.results.length}`);
        }
        
        // For each video, navigate directly to it instead of clicking (more reliable)
        for (let i = startIndex; i < videoElements.results.length; i++) {
          if (userId && !(await isAutomationRunning(userId))) {
            console.log('[TikTok Search] Automation stopped - exiting video loop');
            return { posts, nextKeywordIndex };
          }
          const videoElement = videoElements.results[i];
          // Check if href is already a full URL or just a path
          const videoUrl = videoElement.href.startsWith('http') 
            ? videoElement.href 
            : `https://www.tiktok.com${videoElement.href}`;
          
          if (userId) {
            await updateAutomationCheckpoint(userId, {
              accountId: currentAccountId,
              keywordIndex,
              videoIndex: i,
              videoUrl,
              stage: 'video_nav',
              engagementIndex: 0,
              engagementUsername: null
            });
          }
          
          try {
            // Navigate directly to the video URL
            console.log(`[TikTok Search] Navigating to video ${i + 1}/${videoElements.results.length} (${videoUrl})...`);
            
            try {
              await page.goto(videoUrl, {
                waitUntil: 'networkidle2',
                timeout: 15000
              });
            } catch (navError) {
              console.log(`[TikTok Search] Navigation timeout, continuing...`);
            }
            
            // Check if automation is still running before processing video
            if (userId && !(await isAutomationRunning(userId))) {
              console.log(`[TikTok Search] Automation stopped - halting video processing`);
              return;
            }
            
            // Check if account is paused before processing video
            if (await isAccountPaused(currentAccountId)) {
              console.log(`[TikTok Search] ⏸️ Account ${currentAccountId} is paused - halting video processing`);
              return;
            }
            
            // Wait for ACTUAL video page content to load (not just the shell)
            console.log(`[TikTok Search] Waiting for video page content to render...`);
            try {
              // Wait for these specific video page elements
              await page.waitForSelector('[data-e2e="browse-video"], [data-e2e="browse-username"], [data-e2e="comment-icon"], video', { 
                timeout: 15000 
              });
              console.log(`[TikTok Search] Video content detected!`);
              
              // Check if account is paused before processing comments
              if (await isAccountPaused(currentAccountId)) {
                console.log(`[TikTok Search] ⏸️ Account ${currentAccountId} is paused - stopping`);
                if (userId) {
                  sendUserEvent(userId, { 
                    type: 'info', 
                    text: `⏸️ Account paused - automation stopped` 
                  });
                }
                return;
              }
              
              if (userId) {
                await updateAutomationCheckpoint(userId, {
                  accountId: currentAccountId,
                  keywordIndex,
                  videoIndex: i,
                  videoUrl,
                  stage: 'comments'
                });
              }
              
              // Send to Live Feed AFTER successful navigation
              if (userId) {
                sendUserEvent(userId, { 
                  type: 'info', 
                  text: `👓 Reading comments on ${videoUrl}` 
                });
              }
              
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
                
                // Check if account is paused while waiting for comments to render
                if (await isAccountPaused(currentAccountId)) {
                  console.log(`[TikTok Search] ⏸️ Account ${currentAccountId} is paused - stopping comment scrape`);
                  return;
                }
                
                // Wait for comments section to open and render
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // CRITICAL: Wait for comment section to be visible before proceeding
                let commentsReady = false;
                try {
                  // Check if paused before waiting for comments to render
                  if (await isAccountPaused(currentAccountId)) {
                    console.log(`[TikTok Search] ⏸️ Account ${currentAccountId} is paused - stopping`);
                    return;
                  }
                  
                  await page.waitForSelector('[data-e2e="comment-level-1"]', { 
                    timeout: 8000,
                    visible: true // Wait for it to be VISIBLE, not just in DOM
                  });
                  commentsReady = true;
                  console.log(`[TikTok Search] ✅ Comments section is now visible and ready`);
                } catch (waitErr) {
                  console.log(`[TikTok Search] ⚠️ Comments section did not become visible after clicking`);
                  
                  // Send to Live Feed
                  if (userId) {
                    sendUserEvent(userId, { 
                      type: 'error', 
                      text: `❌ Comment button not detected` 
                    });
                  }
                }
                
                // If comments aren't visible, skip this video
                if (!commentsReady) {
                  console.log(`[TikTok Search] Skipping video - comments not accessible`);
                  await page.goBack();
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  continue;
                }
                
              } catch (clickErr) {
                console.log(`[TikTok Search] Could not click comments button:`, clickErr);
              }
              
            } catch (err) {
              console.log(`[TikTok Search] Video page content didn't load, skipping this video`);
              
              if (userId) {
                await updateAutomationCheckpoint(userId, {
                  accountId: currentAccountId,
                  keywordIndex,
                  videoIndex: i,
                  videoUrl,
                  stage: 'video_failed'
                });
              }
              
              // Send to Live Feed
              if (userId) {
                sendUserEvent(userId, { 
                  type: 'error', 
                  text: `❌ Video failed to load` 
                });
              }
              
              await page.goBack();
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
            
            // Scroll comments using Puppeteer's trusted mouse events (TikTok blocks synthetic JS scrolling)
            console.log(`[TikTok Search] Scrolling comments section to load more comments...`);
            try {
              // Get the scrollable container position and total comment count
              const scrollInfo = await page.evaluate(() => {
                // CRITICAL: Detect browser zoom level
                const zoom = window.devicePixelRatio || 1;
                const computedZoom = parseFloat(getComputedStyle(document.body).zoom || '1');
                const effectiveZoom = zoom / computedZoom;
                
                console.log(`[Browser] Zoom detected: ${effectiveZoom.toFixed(2)}x (devicePixelRatio: ${zoom}, body zoom: ${computedZoom})`);
                
                // Get total comment count - prioritize the count that appears after opening comments panel
                const commentsCountEl = document.querySelector('[class*="DivCommentCountContainer"]') ||
                                       document.querySelector('[data-e2e="comment-count"]') ||
                                       document.querySelector('[data-e2e="browse-comment-count"]');
                const totalComments = parseInt(commentsCountEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
                
                // Find the COMMENTS panel scrollable container (not video sidebar)
                const containers = Array.from(document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]'));
                
                console.log(`[Browser] Found ${containers.length} potential containers`);
                
                const container = containers.find(el => {
                  const rect = el.getBoundingClientRect();
                  // Comments panel is wider (250px+), video sidebar is narrow (~72px)
                  const isWideEnough = rect.width > 150 && rect.height > 150;
                  
                  if (isWideEnough) {
                    console.log(`[Browser] Container: width=${rect.width.toFixed(0)}px, height=${rect.height.toFixed(0)}px, left=${rect.left.toFixed(0)}px, top=${rect.top.toFixed(0)}px`);
                  }
                  
                  return isWideEnough;
                }) as HTMLElement | undefined;
                
                if (container) {
                  const rect = container.getBoundingClientRect();
                  const viewportHeight = window.innerHeight;
                  
                  // Position X in center of container
                  const x = rect.left + rect.width / 2;
                  
                  // CRITICAL: Position Y within visible viewport, not at middle of total scrollable height
                  // rect.height includes ALL scrolled content (can be 2000px+), but viewport is ~600px
                  const safeYOffset = 200; // pixels below top of container
                  const y = Math.min(rect.top + safeYOffset, viewportHeight * 0.6);
                  
                  console.log(`[Browser] Selected container: x=${x.toFixed(0)}, y=${y.toFixed(0)}, viewport=${viewportHeight}px`);
                  
                  return {
                    found: true,
                    x: x,
                    y: y,
                    totalComments,
                    zoom: effectiveZoom,
                    rectInfo: { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
                  };
                }
                
                console.log(`[Browser] ❌ No suitable container found`);
                return { found: false, totalComments, zoom: effectiveZoom };
              });
              
              console.log(`[TikTok Search] 📊 Total comments on video: ${scrollInfo.totalComments}`);
              console.log(`[TikTok Search] 🔍 Browser zoom: ${scrollInfo.zoom?.toFixed(2)}x`);
              
              if (scrollInfo.found) {
                console.log(`[TikTok Search] 📐 Container rect:`, scrollInfo.rectInfo);
                console.log(`[TikTok Search] 🖱️ Mouse position: (${Math.round(scrollInfo.x)}, ${Math.round(scrollInfo.y)})`);
                
                // Position mouse over the scrollable container
                await page.mouse.move(scrollInfo.x, scrollInfo.y);
                console.log(`[TikTok Search] ✅ Mouse positioned over comments`);
                await new Promise(resolve => setTimeout(resolve, 1500)); // Increased wait time
                
                let loadedComments = 0;
                let scrollAttempts = 0;
                const maxScrollAttempts = 50;
                let noChangeCount = 0;
                
                while (loadedComments < scrollInfo.totalComments && scrollAttempts < maxScrollAttempts) {
                  scrollAttempts++;
                  const beforeCount = loadedComments;
                  
                  // Use trusted Puppeteer mouse wheel event
                  await page.mouse.wheel({ deltaY: 800 });
                  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for TikTok lazy load
                  
                  loadedComments = await page.evaluate(() => {
                    return document.querySelectorAll('[data-e2e="comment-level-1"]').length;
                  });
                  
                  const increased = loadedComments > beforeCount;
                  const percentage = Math.round((loadedComments / scrollInfo.totalComments) * 100);
                  
                  if (scrollAttempts % 5 === 0 || increased) {
                    console.log(`[TikTok Search] 📊 Scroll ${scrollAttempts}: ${beforeCount} → ${loadedComments}/${scrollInfo.totalComments} (${percentage}%) ${increased ? '✅' : '⚠️'}`);
                  }
                  
                  if (loadedComments >= scrollInfo.totalComments) {
                    console.log(`[TikTok Search] ✅ All comments loaded! (${loadedComments}/${scrollInfo.totalComments})`);
                    break;
                  }
                  
                  // Stop if no progress after 5 consecutive attempts (more patient)
                  if (!increased) {
                    noChangeCount++;
                    if (noChangeCount >= 5) {
                      console.log(`[TikTok Search] ⚠️ No new comments after ${noChangeCount} attempts - stopping at ${percentage}%`);
                      break;
                    }
                  } else {
                    noChangeCount = 0;
                  }
                }
                
                console.log(`[TikTok Search] ✅ Finished scrolling after ${scrollAttempts} attempts: loaded ${loadedComments} comments`);
              } else {
                console.log(`[TikTok Search] ❌ Could not find scrollable container`);
              }
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
              
              if (userId && countVerification.expectedCount > 0 && countVerification.scrapedCount === 0 && commentRateLimitTracker) {
                const previousCount = commentRateLimitTracker.get(currentAccountId) || 0;
                const nextCount = previousCount + 1;
                commentRateLimitTracker.set(currentAccountId, nextCount);
                console.log(`[TikTok Search] ⚠️ No comments loaded despite ${countVerification.expectedCount} expected (consecutive ${nextCount}/3)`);
                if (nextCount >= 3) {
                  await snoozeAccount(currentAccountId, userId);
                  throw new Error('COMMENT_RATE_LIMIT');
                }
              } else if (commentRateLimitTracker) {
                commentRateLimitTracker.set(currentAccountId, 0);
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
                  // Username: Extract actual username from href, not display name (which may have emojis)
                  const usernameContainer = el.closest('[class*="DivCommentItemWrapper"]')?.querySelector('[data-e2e^="comment-username"]');
                  const usernameLink = usernameContainer?.querySelector('a');
                  
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
                    commentUsername = (usernameContainer?.querySelector('a p') || 
                                      usernameContainer?.querySelector('p'))?.textContent?.trim().replace('@', '') || '';
                  }
                  
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
            
            // Send comment count to Live Feed
            if (userId) {
              sendUserEvent(userId, { 
                type: 'info', 
                text: `🎯 ${videoData.comments.length} comments found!` 
              });
            }
            
            // Replace comments with filtered ones
            videoData.comments = filteredComments;
            
            if (userId) {
              await updateAutomationCheckpoint(userId, {
                accountId: currentAccountId,
                keywordIndex,
                videoIndex: i,
                videoUrl: videoData.post.videoUrl,
                stage: 'analyze',
                engagementIndex: 0,
                engagementUsername: null
              });
            }
            
            // === OPENAI ANALYSIS & ENGAGEMENT ===
            // Initialize stats
            let acceptedCount = 0;
            let rejectedCount = 0;
            
            // Only proceed with OpenAI analysis if we have recent comments to analyze
            if (userId && userConfig && filteredComments.length > 0) {
              try {
                console.log(`[TikTok Search] Analyzing ${filteredComments.length} comments for buying intent...`);
                let activeUserConfig = userConfig;
                
                // Send to OpenAI for buying intent analysis
                let buyingIntentResults = await analyzeCommentsForBuyingIntent(
                  filteredComments,
                  videoData.post.videoUrl,
                  activeUserConfig
                );
                let analysisAccountId = currentAccountId;

                const reloadAnalysisForCurrentAccount = async (accountForConfig: any): Promise<boolean> => {
                  if (!getUserConfigForAccount) {
                    return true;
                  }

                  const refreshedUserConfig = await getUserConfigForAccount(accountForConfig);
                  if (!refreshedUserConfig) {
                    return false;
                  }

                  activeUserConfig = refreshedUserConfig;
                  console.log(`[TikTok Search] Re-analyzing comments with Group prompts for account ${currentAccountId}`);
                  buyingIntentResults = await analyzeCommentsForBuyingIntent(
                    filteredComments,
                    videoData.post.videoUrl,
                    activeUserConfig
                  );
                  analysisAccountId = currentAccountId;
                  return true;
                };
                
                acceptedCount = buyingIntentResults.filter(r => r.hasBuyingIntent).length;
                rejectedCount = filteredComments.length - acceptedCount;
                
                console.log(`[TikTok Search] OpenAI identified ${acceptedCount} comments with buying intent`);
                
                // Send acceptance/rejection stats to Live Feed (only once, before engagements)
                if (userId) {
                  sendUserEvent(userId, { 
                    type: 'info', 
                    text: `👍 ${acceptedCount} accepted` 
                  });
                  sendUserEvent(userId, { 
                    type: 'info', 
                    text: `👎 ${rejectedCount} rejected` 
                  });
                }
                
                const isResumeVideo = (resumeVideoUrl && videoData.post.videoUrl === resumeVideoUrl) || (!resumeVideoUrl && resumeVideoIndex === i);
                const engagementStartIndex = (isResumeVideo && resumeStage === 'engage') ? resumeEngagementIndex : 0;
                
                // Engage with users who have buying intent
                for (let engagementIndex = 0; engagementIndex < buyingIntentResults.length; engagementIndex++) {
                  if (userId && !(await isAutomationRunning(userId))) {
                    console.log('[TikTok Search] Automation stopped - exiting engagement loop');
                    return { posts, nextKeywordIndex };
                  }
                  if (analysisAccountId !== currentAccountId) {
                    const reanalysisSucceeded = await reloadAnalysisForCurrentAccount(currentAccountId);
                    if (!reanalysisSucceeded) {
                      return { posts, nextKeywordIndex };
                    }
                  }

                  let result = buyingIntentResults[engagementIndex];
                  if (engagementIndex < engagementStartIndex) {
                    continue;
                  }
                  if (result.hasBuyingIntent && result.customizedDM && result.customizedReply) {
                    if (userId) {
                      await updateAutomationCheckpoint(userId, {
                        accountId: currentAccountId,
                        keywordIndex,
                        videoIndex: i,
                        videoUrl: videoData.post.videoUrl,
                        stage: 'engage',
                        engagementIndex,
                        engagementUsername: result.username
                      });
                    }
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
                    
                    sendUserEvent(userId, {
                      type: 'success',
                      text: `🎯 Buying intent found`
                    });
                    
                    // PHASE 3: Engagement with account rotation
                    let engagementResult = await engageWithUser(
                      page,
                      userId,
                      currentAccountId,
                      result.username,
                      videoData.post.videoUrl,
                      result.customizedDM,
                      result.customizedReply
                    );
                    
                    // PHASE 3: Check for rate limit detection
                    if (!engagementResult.success && (engagementResult as any).rateLimitDetected) {
                      console.log(`[Account Rotation] 🚫 RATE LIMIT DETECTED for account ${currentAccountId}`);
                      
                      // Snooze this account
                      await snoozeAccount(currentAccountId, userId);
                      
                      // Try to switch to next available account
                      const nextAccount = await getNextAvailableAccount(userId, currentAccountId);
                      
                      if (nextAccount) {
                        console.log(`[Account Rotation] 🔄 Switching to account ${nextAccount.id} (@${nextAccount.account_identifier})`);
                        
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `🔄 Switching to account @${nextAccount.account_identifier}`
                        });
                        
                        // Get or create context for new account
                        if (!getBrowserContextForAccount) {
                          throw new Error('getBrowserContextForAccount not available');
                        }
                        const newCtx = await getBrowserContextForAccount(nextAccount);
                        page = newCtx.page;
                        currentAccountId = nextAccount.id;
                        currentAccount = nextAccount;
                        
                        // Reset action counter for new account
                        await resetActionCounter(currentAccountId);
                        
                        if (userId) {
                          await updateAutomationCheckpoint(userId, {
                            accountId: currentAccountId,
                            keywordIndex,
                            videoIndex: i,
                            videoUrl: videoData.post.videoUrl,
                            stage: 'engage'
                          });
                        }
                        
                        // Retry engagement with new account
                        const reanalysisSucceeded = await reloadAnalysisForCurrentAccount(nextAccount);
                        if (!reanalysisSucceeded) {
                          return { posts, nextKeywordIndex };
                        }
                        result = buyingIntentResults[engagementIndex];
                        if (!result?.hasBuyingIntent || !result.customizedDM || !result.customizedReply) {
                          console.log(`[TikTok Search] Skipping @${result?.username || 'unknown'} after account switch due to updated analysis`);
                          continue;
                        }

                        console.log(`[Account Rotation] 🔁 Retrying engagement with new account...`);
                        engagementResult = await engageWithUser(
                          page,
                          userId,
                          currentAccountId,
                          result.username,
                          videoData.post.videoUrl,
                          result.customizedDM,
                          result.customizedReply
                        );
                      } else {
                        console.log(`[Account Rotation] ❌ No more available accounts - all snoozed`);
                        sendUserEvent(userId, {
                          type: 'error',
                          text: `❌ All accounts rate limited - pausing automation`
                        });
                        // Exit the search loop
                        return;
                      }
                    }
                    
                    // PHASE 3: Increment action counter if engagement succeeded
                    if (engagementResult.success) {
                      const rotationCheck = await incrementActionCounter(currentAccountId);
                      
                      console.log(`[Account Rotation] 📊 Actions: ${rotationCheck.currentActions}/${rotationCheck.limit}`);
                      
                      // Check if we need to rotate accounts
                      if (rotationCheck.shouldRotate) {
                        const nextAccount = await getNextAvailableAccount(userId, currentAccountId);
                        
                        if (nextAccount) {
                          // Check if it's the same account (only one account available)
                          if (nextAccount.id === currentAccountId) {
                            console.log(`[Account Rotation] ⚠️ Only one account available - resetting action counter`);
                            sendUserEvent(userId, {
                              type: 'info',
                              text: `⚠️ Action limit reached. Only one account available - continuing...`
                            });
                            
                            // Reset action counter for this account to continue
                            await connection.query(
                              'UPDATE tiktok_accounts SET current_session_actions = 0 WHERE id = ?',
                              [currentAccountId]
                            );
                            
                            // Continue with next engagement in the loop
                            continue;
                          }
                          
                          console.log(`[Account Rotation] ⚠️ Action limit reached for account ${currentAccountId}`);
                          console.log(`[Account Rotation] 🔄 Switching to account ${nextAccount.id} (@${nextAccount.account_identifier})...`);
                          
                          sendUserEvent(userId, {
                            type: 'warning',
                            text: `⚠️ Action limit reached (${rotationCheck.currentActions} actions). Switching to next account...`
                          });
                          
                          try {
                            // Get next account's full configuration
                            const [nextAccountRows] = await connection.query(
                              'SELECT id, account_identifier, browser_type, incogniton_profile_id, session_data FROM tiktok_accounts WHERE id = ?',
                              [nextAccount.id]
                            );
                            
                            const nextAccountConfig = (nextAccountRows as any[])[0] as TikTokAccount;
                            
                            // Switch browser connection to next account
                            browserConnection = await switchToAccount(browserConnection, nextAccountConfig);
                            page = browserConnection.page;
                            
                            // Reset counter for the newly selected account
                            await resetActionCounter(nextAccount.id);
                            
                            // Update current account ID for this search session
                            currentAccountId = nextAccount.id;
                            // Note: currentAccount is in outer scope, will be updated after search completes
                            
                            if (userId) {
                              await updateAutomationCheckpoint(userId, {
                                accountId: currentAccountId,
                                keywordIndex,
                                videoIndex: i,
                                videoUrl: videoData.post.videoUrl,
                                stage: 'engage'
                              });
                            }
                            
                            console.log(`[Account Rotation] ✅ Successfully switched to account ${nextAccount.id}`);
                            sendUserEvent(userId, {
                              type: 'success',
                              text: `✅ Switched to account @${nextAccount.account_identifier}`
                            });
                            
                            // Continue with engagement loop
                          } catch (switchError) {
                            console.error(`[Account Rotation] ❌ Failed to switch accounts:`, switchError);
                            sendUserEvent(userId, {
                            type: 'error',
                              text: `❌ Failed to switch accounts: ${switchError instanceof Error ? switchError.message : 'Unknown error'}`
                            });
                            
                            // Exit gracefully if switch fails
                            return;
                          }
                        } else {
                          console.log(`[Account Rotation] ⚠️ No more available accounts for rotation - all exhausted`);
                          sendUserEvent(userId, {
                            type: 'warning',
                            text: `⚠️ All accounts exhausted - pausing automation`
                          });
                          // Exit the search loop
                          return;
                        }
                      }
                    }
                    
                    // Send live feed notification based on result
                    if (engagementResult.success) {
                      if (engagementResult.method === 'dm') {
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `✉️ Sending DM`
                        });
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `"${result.customizedDM}"`
                        });
                        sendUserEvent(userId, {
                          type: 'success',
                          text: `✅ DM sent successfully!`
                        });
                      } else if (engagementResult.method === 'comment') {
                        sendUserEvent(userId, {
                          type: 'warning',
                          text: `⚠️ DM failed, posting comment reply...`
                        });
                        sendUserEvent(userId, {
                          type: 'info',
                          text: `"${result.customizedReply}"`
                        });
                        sendUserEvent(userId, {
                          type: 'success',
                          text: `✅ Comment reply posted successfully!`
                        });
                      }
                    } else if (engagementResult.method === 'skipped') {
                      sendUserEvent(userId, {
                        type: 'success',
                        text: `✔️ Already contacted`
                      });
                    } else {
                      // Both DM and comment failed
                      sendUserEvent(userId, {
                        type: 'error',
                        text: `❌ Failed to engage: ${engagementResult.error}`
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
            } else if (userId && filteredComments.length === 0) {
              // If no recent comments to analyze, still send 0/0 stats
              sendUserEvent(userId, { 
                type: 'info', 
                text: `👍 0 accepted` 
              });
              sendUserEvent(userId, { 
                type: 'info', 
                text: `👎 0 rejected` 
              });
            }
            
            if (userId) {
              await updateAutomationCheckpoint(userId, {
                accountId: currentAccountId,
                keywordIndex,
                videoIndex: i + 1,
                videoUrl: null,
                stage: 'video_done',
                engagementIndex: 0,
                engagementUsername: null
              });
            }
            
            posts.push(videoData);
            
            // Navigate back to search results (don't use goBack - forces fresh load)
            console.log(`[TikTok Search] Navigating back to search results for "${keyword}"...`);
            await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, {
              waitUntil: 'networkidle2',
              timeout: 15000
            }).catch(() => console.log('[TikTok Search] Navigation timeout, continuing...'));
            await new Promise(resolve => setTimeout(resolve, 3000));
            
          } catch (videoError) {
            console.error(`[TikTok Search] Error processing video ${i + 1}:`, videoError);
            // Navigate back to search results if we're stuck
            try {
              console.log(`[TikTok Search] Error recovery - navigating back to search results for "${keyword}"...`);
              await page.goto(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, {
                waitUntil: 'networkidle2',
                timeout: 15000
              }).catch(() => console.log('[TikTok Search] Navigation timeout, continuing...'));
              await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (backError) {
              console.error('[TikTok Search] Could not navigate back to search results');
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
 * PHASE 3: Get next available (non-snoozed) account for rotation
 */
async function getNextAvailableAccount(userId: number, currentAccountId: number, preferredGroupId: number | null = null): Promise<any | null> {
  const connection = await db.getConnection();
  try {
    // Query for next available account:
    // 1. Belongs to this user
    // 2. Is active
    // 3. NOT paused
    // 4. NOT rate limited OR rate limit has expired
    // 5. Preferably a different account than current (for rotation)
    const [accounts] = await connection.query(
      `SELECT id, account_identifier, session_data, actions_per_session, current_session_actions, 
              is_rate_limited, rate_limit_expires_at, last_keyword_index, group_id
       FROM tiktok_accounts 
       WHERE user_id = ? 
         AND is_active = 1 
         AND is_paused = FALSE
         AND (is_rate_limited = FALSE OR rate_limit_expires_at IS NULL OR rate_limit_expires_at < NOW())
       ORDER BY 
         CASE WHEN id = ? THEN 0 ELSE 1 END DESC,  -- Prefer different account (1=different comes first with DESC)
         CASE WHEN group_id = ? THEN 1 ELSE 0 END DESC,  -- Prefer checkpoint Group when resuming
         last_used_at ASC,  -- Least recently used first
         id ASC
       LIMIT 1`,
      [userId, currentAccountId, preferredGroupId ?? -1]
    );
    
    if (!accounts || (accounts as any[]).length === 0) {
      console.log(`[Account Rotation] ⚠️ No available accounts for user ${userId} - all may be snoozed or paused`);
      return null;
    }
    
    const account = (accounts as any[])[0];
    console.log(`[Account Rotation] ✅ Selected account ${account.id} (@${account.account_identifier})`);
    
    // Update last_used_at timestamp
    await connection.query(
      'UPDATE tiktok_accounts SET last_used_at = NOW() WHERE id = ?',
      [account.id]
    );
    
    return account;
  } finally {
    connection.release();
  }
}

/**
 * PHASE 3: Snooze an account for 24.5 hours due to rate limiting
 */
async function snoozeAccount(accountId: number, userId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    // Calculate 24.5 hours from now
    await connection.query(
      `UPDATE tiktok_accounts 
       SET is_rate_limited = TRUE,
           rate_limit_detected_at = NOW(),
           rate_limit_expires_at = DATE_ADD(NOW(), INTERVAL 24.5 HOUR),
           current_session_actions = 0
       WHERE id = ?`,
      [accountId]
    );
    
    console.log(`[Account Rotation] 😴 Account ${accountId} snoozed for 24.5 hours due to rate limit`);
    
    // Notify user
    sendUserEvent(userId, {
      type: 'warning',
      text: `⚠️ Account rate limited - snoozed for 24.5 hours`
    });
  } finally {
    connection.release();
  }
}

/**
 * PHASE 3: Increment action counter and check if rotation needed
 */
async function incrementActionCounter(accountId: number): Promise<{ shouldRotate: boolean; currentActions: number; limit: number }> {
  const connection = await db.getConnection();
  try {
    // Increment current_session_actions
    await connection.query(
      'UPDATE tiktok_accounts SET current_session_actions = current_session_actions + 1 WHERE id = ?',
      [accountId]
    );
    
    // Get updated values
    const [rows] = await connection.query(
      'SELECT current_session_actions, actions_per_session FROM tiktok_accounts WHERE id = ?',
      [accountId]
    );
    
    const account = (rows as any[])[0];
    const shouldRotate = account.current_session_actions >= account.actions_per_session;
    
    if (shouldRotate) {
      console.log(`[Account Rotation] 🔄 Action limit reached (${account.current_session_actions}/${account.actions_per_session}) - rotation needed`);
    }
    
    return {
      shouldRotate,
      currentActions: account.current_session_actions,
      limit: account.actions_per_session
    };
  } finally {
    connection.release();
  }
}

/**
 * PHASE 3: Reset action counter when rotating to new account
 */
async function resetActionCounter(accountId: number): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      'UPDATE tiktok_accounts SET current_session_actions = 0 WHERE id = ?',
      [accountId]
    );
    console.log(`[Account Rotation] 🔄 Action counter reset for account ${accountId}`);
  } finally {
    connection.release();
  }
}

type AutomationCheckpoint = {
  accountId: number | null;
  groupId: number | null;
  keywordIndex: number | null;
  videoIndex: number | null;
  videoUrl: string | null;
  stage: string | null;
  engagementIndex: number | null;
  engagementUsername: string | null;
};

async function getAutomationCheckpoint(userId: number): Promise<AutomationCheckpoint | null> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT checkpoint_account_id, checkpoint_keyword_index, checkpoint_video_index,
              checkpoint_video_url, checkpoint_stage, checkpoint_engagement_index,
              checkpoint_engagement_username,
              (SELECT ta.group_id FROM tiktok_accounts ta WHERE ta.id = automation_state.checkpoint_account_id LIMIT 1) AS checkpoint_group_id
       FROM automation_state
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    const row = (rows as any[])[0];
    if (!row) {
      return null;
    }

    return {
      accountId: row.checkpoint_account_id ?? null,
      groupId: row.checkpoint_group_id ?? null,
      keywordIndex: row.checkpoint_keyword_index ?? null,
      videoIndex: row.checkpoint_video_index ?? null,
      videoUrl: row.checkpoint_video_url ?? null,
      stage: row.checkpoint_stage ?? null,
      engagementIndex: row.checkpoint_engagement_index ?? null,
      engagementUsername: row.checkpoint_engagement_username ?? null
    };
  } finally {
    connection.release();
  }
}

async function updateAutomationCheckpoint(userId: number, checkpoint: Partial<AutomationCheckpoint>): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      'INSERT INTO automation_state (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      [userId]
    );

    const fields: string[] = [];
    const values: any[] = [];

    if ('accountId' in checkpoint) {
      fields.push('checkpoint_account_id = ?');
      values.push(checkpoint.accountId);
    }
    if ('keywordIndex' in checkpoint) {
      fields.push('checkpoint_keyword_index = ?');
      values.push(checkpoint.keywordIndex ?? 0);
    }
    if ('videoIndex' in checkpoint) {
      fields.push('checkpoint_video_index = ?');
      values.push(checkpoint.videoIndex ?? 0);
    }
    if ('videoUrl' in checkpoint) {
      fields.push('checkpoint_video_url = ?');
      values.push(checkpoint.videoUrl);
    }
    if ('stage' in checkpoint) {
      fields.push('checkpoint_stage = ?');
      values.push(checkpoint.stage);
    }
    if ('engagementIndex' in checkpoint) {
      fields.push('checkpoint_engagement_index = ?');
      values.push(checkpoint.engagementIndex ?? 0);
    }
    if ('engagementUsername' in checkpoint) {
      fields.push('checkpoint_engagement_username = ?');
      values.push(checkpoint.engagementUsername);
    }

    if (fields.length === 0) {
      return;
    }

    values.push(userId);
    await connection.query(
      `UPDATE automation_state SET ${fields.join(', ')} WHERE user_id = ?`,
      values
    );
  } finally {
    connection.release();
  }
}

async function isAutomationRunning(userId: number): Promise<boolean> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT is_running FROM automation_state WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const row = (rows as any[])[0];
    return Boolean(row?.is_running);
  } finally {
    connection.release();
  }
}

/**
 * Check if a specific account is paused
 */
async function isAccountPaused(accountId: number): Promise<boolean> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT is_paused FROM tiktok_accounts WHERE id = ? LIMIT 1',
      [accountId]
    );
    const row = (rows as any[])[0];
    return Boolean(row?.is_paused);
  } finally {
    connection.release();
  }
}

/**
 * Run TikTok search for a specific user's accounts
 * PHASE 3: Multi-context worker with account rotation
 */
export async function runTikTokSearchForAccounts(userId: number) {
  const connection = await db.getConnection();
  
  try {
    console.log(`[TikTok Search Worker] Starting search for user ${userId} accounts...`);
    
    // Get user's active TikTok accounts (including rate limit status)
    const [accounts] = await connection.query(
      `SELECT id, account_identifier, session_data, actions_per_session, current_session_actions,
              is_rate_limited, rate_limit_expires_at, last_keyword_index, group_id
       FROM tiktok_accounts 
       WHERE user_id = ? AND is_active = 1`,
      [userId]
    );
    
    if (!accounts || (accounts as any[]).length === 0) {
      console.log('[TikTok Search Worker] No active accounts found');
      return;
    }
    
    const allAccounts = accounts as any[];
    console.log(`[TikTok Search Worker] Found ${allAccounts.length} total accounts`);
    
    // Check how many are snoozed
    const snoozedAccounts = allAccounts.filter(acc => 
      acc.is_rate_limited && acc.rate_limit_expires_at && new Date(acc.rate_limit_expires_at) > new Date()
    );
    const availableAccounts = allAccounts.length - snoozedAccounts.length;
    
    if (snoozedAccounts.length > 0) {
      console.log(`[TikTok Search Worker] ⚠️ ${snoozedAccounts.length} account(s) currently snoozed (rate limited)`);
      sendUserEvent(userId, {
        type: 'warning',
        text: `${snoozedAccounts.length} account(s) snoozed - using ${availableAccounts} available account(s)`
      });
    }
    
    if (availableAccounts === 0) {
      console.log('[TikTok Search Worker] ⚠️ All accounts are snoozed - cannot proceed');
      sendUserEvent(userId, {
        type: 'error',
        text: `❌ All accounts are rate limited. Please wait for snooze period to expire.`
      });
      return;
    }
    
    // Get user's keywords from config
    const [configRows] = await connection.query(
      'SELECT keywords, creator_message, openai_api_key FROM user_config WHERE user_id = ?',
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
    
    const baseCreatorMessage = configData.creator_message;
    const openaiApiKey = configData.openai_api_key;

    const getUserConfigForAccount = async (accountForConfig: any): Promise<any | null> => {
      const accountIdForConfig = typeof accountForConfig === 'number'
        ? accountForConfig
        : Number(accountForConfig?.id || 0);

      if (!accountIdForConfig) {
        return null;
      }

      const [accountRowsForConfig] = await connection.query(
        `SELECT id, account_identifier, group_id
         FROM tiktok_accounts
         WHERE id = ? AND user_id = ? AND is_active = 1
         LIMIT 1`,
        [accountIdForConfig, userId]
      );

      const accountForConfigRow = (accountRowsForConfig as any[])[0];
      if (!accountForConfigRow) {
        return null;
      }

      const groupId = Number(accountForConfigRow.group_id || 0);
      if (!groupId) {
        sendUserEvent(userId, {
          type: 'error',
          text: `❌ @${accountForConfigRow.account_identifier} has no Group assigned. Assign a Group in settings before running.`
        });
        return null;
      }

      const [groupConfigRows] = await connection.query(
        `SELECT ai_prompt, example_dm, example_comment, brand_voice, affiliate_dm_prompt, affiliate_invitation_text
         FROM group_prompt_config
         WHERE user_id = ? AND group_id = ?
         LIMIT 1`,
        [userId, groupId]
      );

      const groupConfig = (groupConfigRows as any[])[0] || null;
      const requiredPrompts = [
        groupConfig?.ai_prompt,
        groupConfig?.example_dm,
        groupConfig?.example_comment,
        groupConfig?.brand_voice,
        groupConfig?.affiliate_dm_prompt,
        groupConfig?.affiliate_invitation_text
      ];

      if (requiredPrompts.some((p: any) => !String(p || '').trim())) {
        sendUserEvent(userId, {
          type: 'error',
          text: `❌ Missing Group prompts for @${accountForConfigRow.account_identifier}. Complete Group settings before running.`
        });
        return null;
      }

      return {
        aiPrompt: groupConfig.ai_prompt,
        creatorMessage: baseCreatorMessage,
        exampleDM: groupConfig.example_dm,
        exampleComment: groupConfig.example_comment,
        openaiApiKey
      };
    };
    
    console.log(`[TikTok Search Worker] Keywords configured: ${keywords.join(', ')}`);
    console.log(`[TikTok Search Worker] PHASE 3: Multi-account rotation enabled`);
    const commentRateLimitTracker = new Map<number, number>();
    
    // Load resume checkpoint (if any)
    const checkpoint = await getAutomationCheckpoint(userId);
    const preferredResumeGroupId = Number(checkpoint?.groupId || 0) || null;
    
    // PHASE 3: Start with checkpoint account if available, otherwise first available account
    let currentAccount: any = null;
    if (checkpoint?.accountId) {
      const [checkpointAccountRows] = await connection.query(
        `SELECT id, account_identifier, session_data, actions_per_session, current_session_actions,
                is_rate_limited, rate_limit_expires_at, is_paused, last_keyword_index, group_id
         FROM tiktok_accounts
         WHERE id = ? AND user_id = ? AND is_active = 1
         LIMIT 1`,
        [checkpoint.accountId, userId]
      );
      const checkpointAccount = (checkpointAccountRows as any[])[0];
      if (checkpointAccount) {
        const isSnoozed = checkpointAccount.is_rate_limited && checkpointAccount.rate_limit_expires_at && new Date(checkpointAccount.rate_limit_expires_at) > new Date();
        const isPaused = Boolean(checkpointAccount.is_paused);
        if (!isSnoozed && !isPaused) {
          currentAccount = checkpointAccount;
          console.log(`[TikTok Search Worker] Resuming from checkpoint account ${currentAccount.id} (@${currentAccount.account_identifier})`);
        } else if (isPaused) {
          console.log(`[TikTok Search Worker] Checkpoint account ${checkpointAccount.id} is paused - selecting another account`);
        }
      }
    }
    
    if (!currentAccount) {
      currentAccount = await getNextAvailableAccount(userId, -1, preferredResumeGroupId);
    }
    
    if (!currentAccount) {
      console.log('[TikTok Search Worker] No available accounts to start with');
      return;
    }
    
    // ACCOUNT ROTATION LOOP: Continue searching with different accounts until all exhausted
    while (currentAccount) {
      if (!(await isAutomationRunning(userId))) {
        console.log('[TikTok Search Worker] Automation stopped - exiting account loop');
        return;
      }
      console.log(`[TikTok Search Worker] Starting with account ${currentAccount.id} (@${currentAccount.account_identifier})`);
      console.log(`[TikTok Search Worker] Action limit: ${currentAccount.actions_per_session} actions per session`);
      
      // Get account info with browser configuration
      const [accountRows] = await connection.query(
        'SELECT id, account_identifier, browser_type, incogniton_profile_id, session_data FROM tiktok_accounts WHERE id = ?',
        [currentAccount.id]
      );
      
      const account = (accountRows as any[])[0] as TikTokAccount;
      
      // PHASE 4: Use browser manager for connections (supports both Chrome Debug and Incogniton)
      let browserConnection: BrowserConnection | null = null;
      
      try {
        // Connect to browser using appropriate method
        console.log(`[TikTok Search Worker] Connecting browser for account ${account.id} (${account.browser_type})...`);
        browserConnection = await connectBrowserForAccount(account);
        const browser = browserConnection.browser;
        let page = browserConnection.page;
        let currentAccountId = currentAccount.id;
        
        // Search for ONE keyword, but use account rotation for engagements
        const keywordIndex = currentAccount.last_keyword_index || 0;
        const keyword = keywords[keywordIndex];
        
        // Send live feed event: searching
        sendUserEvent(userId, { 
          type: 'info', 
          text: `🔍 Searching for "${keyword}" with @${currentAccount.account_identifier}` 
        });
        
        // Define callback for account rotation (if needed during engagement phase)
        const getBrowserContextForAccount = async (nextAccount: any) => {
          console.log(`[Account Rotation] Switching to account ${nextAccount.id} (@${nextAccount.account_identifier})...`);
          
          // Close current browser connection
          if (browserConnection) {
            await closeBrowserConnection(browserConnection);
          }
          
          // Connect to new account's browser
          browserConnection = await connectBrowserForAccount(nextAccount);
          
          return {
            context: null, // Not used in Phase 4
            page: browserConnection.page
          };
        };
        
        // NOTE: searchTikTokByKeywords will use the existing page and handle engagements with account rotation
        // The page variable may be reassigned during engagement if rotation occurs
        const checkpointGroupMatchesCurrent = Number(checkpoint?.groupId || 0) > 0 && Number(currentAccount.group_id || 0) > 0 && Number(checkpoint?.groupId || 0) === Number(currentAccount.group_id || 0);
        const keywordIndexToUse = (checkpoint && checkpoint.keywordIndex !== null && (checkpoint.accountId === currentAccountId || checkpointGroupMatchesCurrent))
          ? checkpoint.keywordIndex
          : (currentAccount.last_keyword_index || 0);

        const userConfig = await getUserConfigForAccount(currentAccount);
        if (!userConfig) {
          await closeBrowserConnection(browserConnection);
          browserConnection = null;
          currentAccount = await getNextAvailableAccount(userId, currentAccount.id);
          continue;
        }
      
        const result = await searchTikTokByKeywords(
          currentAccountId,
          keywords,
          keywordIndexToUse,
          userId,
          userConfig,
          getUserConfigForAccount,
          getBrowserContextForAccount,
          page,
          checkpoint,
          commentRateLimitTracker
        );
        
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
            [currentAccount.id, post.username, post.caption, post.videoUrl, post.likes, post.commentsCount, post.shares]
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
      if (!(await isAutomationRunning(userId))) {
        console.log('[TikTok Search Worker] Automation stopped - skipping keyword index update');
        return;
      }
      
      await connection.query(
        'UPDATE tiktok_accounts SET last_keyword_index = ?, last_search_at = NOW() WHERE id = ?',
        [result.nextKeywordIndex, currentAccount.id]
      );
      
      await updateAutomationCheckpoint(userId, {
        accountId: currentAccount.id,
        keywordIndex: result.nextKeywordIndex,
        videoIndex: 0,
        videoUrl: null,
        stage: 'search_complete',
        engagementIndex: 0,
        engagementUsername: null
      });
      
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
      
      console.log('[TikTok Search Worker] Search completed for this account');
      
      // ACCOUNT ROTATION: Get next available account and continue if any remain
      const nextAccount = await getNextAvailableAccount(userId, currentAccount.id);
      
      if (nextAccount) {
        console.log(`[TikTok Search Worker] 🔄 Rotating to next account: ${nextAccount.id} (@${nextAccount.account_identifier})`);
        sendUserEvent(userId, {
          type: 'info',
          text: `🔄 Rotating to account @${nextAccount.account_identifier}...`
        });
        currentAccount = nextAccount;
        // Loop will continue with new account
      } else {
        console.log('[TikTok Search Worker] ✅ All accounts completed - no more available accounts');
        sendUserEvent(userId, {
          type: 'success',
          text: '✅ All accounts completed!'
        });
        currentAccount = null; // Exit loop
      }
      
    } catch (error) {
      console.error(`[TikTok Search Worker] Error during search:`, error);
      if (error instanceof Error && error.message === 'COMMENT_RATE_LIMIT') {
        console.log('[TikTok Search Worker] Comment rate limit detected - moving to next account');
      } else {
      
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
      }
      
      // On error, try to get next account instead of stopping completely
      const nextAccount = await getNextAvailableAccount(userId, currentAccount.id);
      if (nextAccount) {
        console.log(`[TikTok Search Worker] ⚠️ Error occurred, but continuing with next account: ${nextAccount.id}`);
        sendUserEvent(userId, {
          type: 'warning',
          text: `⚠️ Error on previous account, switching to next...`
        });
        currentAccount = nextAccount;
      } else {
        console.log('[TikTok Search Worker] ❌ Error occurred and no more accounts available');
        currentAccount = null; // Exit loop
      }
    } finally {
      // PHASE 4: Clean up browser connection for this account
      if (browserConnection) {
        try {
          await closeBrowserConnection(browserConnection);
          console.log(`[TikTok Search Worker] ✅ Browser connection closed`);
        } catch (closeError) {
          console.error(`[TikTok Search Worker] ⚠️ Error closing browser connection:`, closeError);
        }
      }
    }
  } // End of account rotation while loop
  
  connection.release();
    
  } catch (error) {
    console.error('[TikTok Search Worker] Error:', error);
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
