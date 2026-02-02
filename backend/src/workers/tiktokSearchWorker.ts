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
      // Navigate to TikTok search first
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
      console.log(`[TikTok Search] Navigating to: ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
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
          
          // Extract video URLs from the found items
          debugInfo.results = items.slice(0, 10).map((item, index) => {
            const link = item.querySelector('a[href*="/video/"]');
            const href = link?.getAttribute('href') || 'unknown';
            return { index, href };
          }).filter(result => result.href !== 'unknown');
          
          return debugInfo;
        });
        
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
        console.log(`[EXTRACTION DEBUG] Extracted ${videoElements.results.length} video URLs:`);
        videoElements.results.forEach((result, i) => {
          console.log(`  ${i + 1}. ${result.href}`);
        });
        
        console.log(`[TikTok Search] Found ${videoElements.results.length} videos from search results for keyword "${keyword}":`);
        videoElements.results.forEach((ve, i) => {
          console.log(`  ${i + 1}. ${ve.href}`);
        });
        
        // For each video, navigate directly to it instead of clicking (more reliable)
        for (let i = 0; i < videoElements.results.length; i++) {
          const videoElement = videoElements.results[i];
          // Check if href is already a full URL or just a path
          const videoUrl = videoElement.href.startsWith('http') 
            ? videoElement.href 
            : `https://www.tiktok.com${videoElement.href}`;
          
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
                
                // Wait for comments section to open and render
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // CRITICAL: Wait for comment section to be visible before proceeding
                let commentsReady = false;
                try {
                  await page.waitForSelector('[data-e2e="comment-level-1"]', { 
                    timeout: 8000,
                    visible: true // Wait for it to be VISIBLE, not just in DOM
                  });
                  commentsReady = true;
                  console.log(`[TikTok Search] ✅ Comments section is now visible and ready`);
                } catch (waitErr) {
                  console.log(`[TikTok Search] ⚠️ Comments section did not become visible after clicking`);
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
                    
                    sendUserEvent(userId, {
                      type: 'success',
                      text: `✅ Buying intent found`
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
