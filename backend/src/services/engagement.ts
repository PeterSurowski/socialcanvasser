import { Page } from 'puppeteer-core';
import db from '../config/database.js';

interface EngagementResult {
  username: string;
  method: 'dm' | 'comment' | 'skipped';
  success: boolean;
  error?: string;
}

/**
 * Check if we've contacted this user before
 */
export async function hasContactedUser(userId: number, tiktokUsername: string): Promise<boolean> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT id FROM contacted_users WHERE user_id = ? AND tiktok_username = ? LIMIT 1',
      [userId, tiktokUsername]
    );
    return (rows as any[]).length > 0;
  } finally {
    connection.release();
  }
}

/**
 * Record that we've contacted a user
 */
export async function recordContact(
  userId: number,
  tiktokUsername: string,
  method: 'dm' | 'comment',
  accountId: number,
  postUrl: string
): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO contacted_users (user_id, tiktok_username, contacted_via, tiktok_account_id, post_url, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE contacted_via = VALUES(contacted_via), created_at = NOW()`,
      [userId, tiktokUsername, method, accountId, postUrl]
    );
  } finally {
    connection.release();
  }
}

/**
 * Log activity
 */
export async function logActivity(
  userId: number,
  accountId: number,
  actionType: 'dm_sent' | 'comment_posted',
  targetUser: string,
  postUrl: string,
  messageContent: string,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  const connection = await db.getConnection();
  try {
    await connection.query(
      `INSERT INTO activity_logs (user_id, tiktok_account_id, action_type, target_user, post_url, message_content, success, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, accountId, actionType, targetUser, postUrl, messageContent, success, errorMessage || null]
    );
  } finally {
    connection.release();
  }
}

/**
 * Try to send a DM to a TikTok user
 * Returns true if successful, false if DM failed (user settings block DMs)
 */
export async function tryToSendDM(
  page: Page,
  username: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[Engagement] 🔍 Step 1/5: Attempting to DM @${username}...`);
    
    // Track navigation events
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        console.log(`[Engagement] 🔄 Page navigated to: ${frame.url()}`);
      }
    });
    
    // Step 1: Navigate to user's profile
    const profileUrl = `https://www.tiktok.com/@${username}`;
    console.log(`[Engagement] 🔍 Step 2/5: Navigating to profile: ${profileUrl}`);
    await page.goto(profileUrl, {
      waitUntil: 'domcontentloaded', // Less strict than networkidle2 for heavy TikTok pages
      timeout: 30000 // Increased from 15s to 30s
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    const afterProfileUrl = page.url();
    console.log(`[Engagement] ✅ Step 2/5: Profile page loaded: ${afterProfileUrl}`);
    
    // Verify we're actually on the profile page
    if (!afterProfileUrl.includes(`/@${username}`)) {
      console.log(`[Engagement] ⚠️ Unexpected URL after profile navigation. Expected: ${profileUrl}, Got: ${afterProfileUrl}`);
    }    
    // Step 2: Wait for profile page content to load (either Message button or Follow button)
    console.log(`[Engagement] 🔍 Step 3/5: Waiting for profile content to load...`);
    try {
      // Wait for SPECIFIC profile buttons only - don't use generic 'button' selector
      await page.waitForSelector('button[data-e2e="message-button"], button[data-e2e="follow-button"], [data-e2e="user-avatar"]', { 
        timeout: 10000 
      });
      console.log(`[Engagement] ✅ Profile content loaded`);
    } catch (waitErr) {
      console.log(`[Engagement] ⚠️ Timeout waiting for profile buttons, continuing anyway...`);
    }
    
    // Step 3: Look for the "Message" button
    console.log(`[Engagement] 🔍 Step 3/5: Looking for Message button with selector [data-e2e="message-button"]...`);
    
    const messageButtonCheck = await page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="message-button"]');
      if (btn) {
        return {
          found: true,
          text: btn.textContent?.trim(),
          disabled: btn.hasAttribute('disabled') || btn.hasAttribute('aria-disabled'),
          visible: (btn as HTMLElement).offsetParent !== null
        };
      }
      
      // Also check for alternative selectors
      const allButtons = Array.from(document.querySelectorAll('button'));
      const messageBtn = allButtons.find(b => b.textContent?.toLowerCase().includes('message'));
      if (messageBtn) {
        return {
          found: true,
          foundViaText: true,
          text: messageBtn.textContent?.trim(),
          disabled: messageBtn.hasAttribute('disabled') || messageBtn.hasAttribute('aria-disabled'),
          visible: messageBtn.offsetParent !== null
        };
      }
      
      // DIAGNOSTICS: What buttons DO we have?
      const allButtonTexts = allButtons.map(b => b.textContent?.trim()).filter(t => t);
      const allDataE2E = Array.from(document.querySelectorAll('[data-e2e]')).map(el => el.getAttribute('data-e2e'));
      const allLinks = Array.from(document.querySelectorAll('a')).map(a => ({
        href: a.getAttribute('href'),
        text: a.textContent?.trim()
      })).filter(l => l.href?.includes('message'));
      
      return { 
        found: false,
        diagnostics: {
          totalButtons: allButtons.length,
          buttonTexts: allButtonTexts.slice(0, 10), // First 10
          dataE2EAttributes: allDataE2E.slice(0, 20), // First 20
          messageLinks: allLinks
        }
      };
    });
    
    console.log(`[Engagement] Message button check result:`, messageButtonCheck);
    
    if (!messageButtonCheck.found) {
      const currentUrl = page.url();
      console.log(`[Engagement] ❌ Step 3/5 FAILED: Message button not found`);
      console.log(`[Engagement] 🔍 Current page when exiting tryToSendDM: ${currentUrl}`);
      if (messageButtonCheck.diagnostics) {
        console.log(`[Engagement] 🔍 DIAGNOSTICS:`);
        console.log(`  - Total buttons on page: ${messageButtonCheck.diagnostics.totalButtons}`);
        console.log(`  - Button texts:`, messageButtonCheck.diagnostics.buttonTexts);
        console.log(`  - data-e2e attributes found:`, messageButtonCheck.diagnostics.dataE2EAttributes);
        console.log(`  - Links with "message":`, messageButtonCheck.diagnostics.messageLinks);
      }
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'Message button not found - user may have DMs disabled' };
    }
    
    // NOTE: Don't check disabled state - TikTok uses aria-disabled even on clickable buttons
    // Just attempt to click it
    console.log(`[Engagement] ✅ Step 3/5: Message button found (${messageButtonCheck.foundViaText ? 'via text match' : 'via data-e2e'})`);
    
    if (messageButtonCheck.disabled) {
      console.log(`[Engagement] ⚠️ Button has disabled attribute, but attempting to click anyway...`);
    }
    
    // Step 4: Click the message button (wrapped in <a> tag that navigates)
    console.log(`[Engagement] 🔍 Step 4/5: Clicking Message button (will navigate to /messages page)...`);
    
    // The button is wrapped in an <a> tag that navigates to /messages?u=...
    // So we need to wait for navigation
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
      console.log(`[Engagement] ⚠️ No navigation detected after 10s, button might open inline compose box`);
    });
    
    const clickResult = await page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="message-button"]') as HTMLElement;
      if (btn) {
        console.log('[Browser] Found button via data-e2e, clicking...');
        btn.click();
        return { method: 'data-e2e', clicked: true };
      }
      
      // Fallback: click the parent <a> tag
      const messageLink = document.querySelector('a[href*="/messages"]') as HTMLElement;
      if (messageLink) {
        console.log('[Browser] Found <a> tag with /messages, clicking...');
        messageLink.click();
        return { method: 'link', clicked: true };
      }
      
      // Fallback: find by text
      const allButtons = Array.from(document.querySelectorAll('button'));
      const messageBtn = allButtons.find(b => b.textContent?.toLowerCase().includes('message'));
      if (messageBtn) {
        console.log('[Browser] Found button via text search, clicking...');
        (messageBtn as HTMLElement).click();
        return { method: 'text', clicked: true };
      }
      
      return { method: 'none', clicked: false };
    });
    
    console.log(`[Engagement] Click result:`, clickResult);
    
    if (!clickResult.clicked) {
      console.log(`[Engagement] ❌ Failed to click Message button - element not found`);
      page.removeAllListeners('framenavigated');
      return { success: false, error: 'Could not find Message button to click' };
    }
    
    // Wait for navigation to complete
    await navigationPromise;
    
    console.log(`[Engagement] ✅ Step 4/5: Message button clicked (${clickResult.method}), current URL: ${page.url()}`);
    
    // Step 5: Wait for DM compose input to load (critical for popup Chrome)
    console.log(`[Engagement] 🔍 Step 5/5: Waiting for DM compose box to load...`);
    
    try {
      // Wait for the DM input area to actually render
      await page.waitForSelector('.public-DraftEditor-content[contenteditable="true"], [contenteditable="true"]', {
        timeout: 10000,
        visible: true
      });
      console.log(`[Engagement] ✅ DM compose box loaded!`);
    } catch (waitError) {
      console.log(`[Engagement] ⚠️ Timeout waiting for DM compose box (10s)`);
      console.log(`[Engagement] Current URL: ${page.url()}`);
      
      // Still check what's on the page for diagnostics
      const dmBoxCheck = await page.evaluate(() => {
        const inputArea = document.querySelector('[data-e2e="message-input-area"]');
        const contentEditable = document.querySelector('[data-e2e="message-input-area"] [contenteditable="true"]');
        const draftEditorContent = document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        const allContentEditables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
        
        return {
          inputAreaFound: !!inputArea,
          contentEditableFound: !!contentEditable,
          draftEditorContentFound: !!draftEditorContent,
          totalContentEditables: allContentEditables.length
        };
      });
      
      console.log(`[Engagement] DM compose box diagnostic:`, dmBoxCheck);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'DM compose box did not load - DMs may be blocked' };
    }
    
    // Double-check that we found the right elements
    const dmBoxCheck = await page.evaluate(() => {
      const inputArea = document.querySelector('[data-e2e="message-input-area"]');
      const contentEditable = document.querySelector('[data-e2e="message-input-area"] [contenteditable="true"]');
      
      // More specific selectors based on actual HTML
      const draftEditorContent = document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      const draftEditorRoot = document.querySelector('.DraftEditor-root');
      
      // Also check for any contenteditable divs that might be DM inputs
      const allContentEditables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      
      return {
        inputAreaFound: !!inputArea,
        contentEditableFound: !!contentEditable,
        draftEditorContentFound: !!draftEditorContent,
        draftEditorRootFound: !!draftEditorRoot,
        totalContentEditables: allContentEditables.length,
        bothFound: !!(inputArea && (contentEditable || draftEditorContent))
      };
    });
    
    console.log(`[Engagement] DM compose box verification:`, dmBoxCheck);
    
    // Now we're confident the compose box is loaded, proceed with typing
    console.log(`[Engagement] ✅ Step 5/5: DM compose box verified! Now typing message...`);
    
    // CRITICAL: Draft.js requires actual typing simulation, not just setting innerText
    // First, click the input to focus it
    await page.click('.public-DraftEditor-content[contenteditable="true"]');
    console.log(`[Engagement] Clicked DM input to focus...`);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Use page.type() to simulate real keyboard input (Draft.js will recognize this)
    console.log(`[Engagement] Typing message (${message.length} characters)...`);
    await page.type('.public-DraftEditor-content[contenteditable="true"]', message, {
      delay: 10 // Small delay between keystrokes to simulate human typing
    });
    
    console.log(`[Engagement] ✅ Message typed successfully!`);
    
    console.log(`[Engagement] Message typed, waiting for Send button to appear...`);
    
    // CRITICAL: Send button only appears AFTER text is entered
    try {
      await page.waitForSelector('[data-e2e="message-send"]', {
        timeout: 5000,
        visible: true
      });
      console.log(`[Engagement] ✅ Send button appeared!`);
    } catch (waitError) {
      console.log(`[Engagement] ⚠️ Send button did not appear after typing`);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'Send button did not appear after typing message' };
    }
    
    // Click send button (it's an SVG, use page.click() not evaluate)
    console.log(`[Engagement] Clicking Send button...`);
    try {
      await page.click('[data-e2e="message-send"]');
      console.log(`[Engagement] ✅ Send button clicked!`);
    } catch (clickError) {
      console.log(`[Engagement] ❌ Failed to click Send button:`, clickError);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'Failed to click Send button' };
    }
    
    // CRITICAL FIX: Count messages BEFORE sending to detect new message
    const messageCountBeforeSend = await page.evaluate(() => {
      return document.querySelectorAll('[data-e2e="chat-item"]').length;
    });
    console.log(`[Engagement] Message count before send: ${messageCountBeforeSend}`);
    
    // Check if message failed to send (failure icon appears after sending)
    console.log(`[Engagement] Checking if message sent successfully...`);
    
    // Wait for the page to update after clicking Send
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check for the dm-warning icon in the message that was just sent
    const hasFailureIcon = await page.evaluate((beforeCount: number) => {
      // Find the most recent message (last chat item)
      const chatItems = document.querySelectorAll('[data-e2e="chat-item"]');
      const afterCount = chatItems.length;
      
      console.log(`[Browser] Before: ${beforeCount}, After: ${afterCount}`);
      
      if (chatItems.length === 0) {
        return { found: false, visible: false, reason: 'No chat items found', chatItemCount: 0, beforeCount, afterCount };
      }
      
      // CRITICAL: Only check the LAST message if count increased (new message added)
      // If count didn't increase, the message might not have been added yet (failure)
      if (afterCount <= beforeCount) {
        console.log(`[Browser] ⚠️ Message count did not increase - message may not have been added to thread`);
        // Don't check for warning icon if no new message appeared
        // This could mean the message is still sending or failed to add to thread
        return { 
          found: false, 
          visible: false,
          chatItemCount: afterCount,
          beforeCount,
          afterCount,
          reason: 'Message count did not increase after send'
        };
      }
      
      const lastMessage = chatItems[chatItems.length - 1];
      const warningContainer = lastMessage.querySelector('[data-e2e="dm-warning"]');
      
      if (warningContainer) {
        // CRITICAL: The container exists in ALL messages, but only FAILED messages have an SVG child
        const warningSvg = warningContainer.querySelector('svg');
        const hasFailureSvg = !!warningSvg;
        console.log(`[Browser] Warning container found, has SVG child: ${hasFailureSvg}`);
        return { 
          found: true, 
          visible: hasFailureSvg,
          chatItemCount: afterCount,
          beforeCount,
          afterCount,
          reason: hasFailureSvg ? 'Failure SVG visible in warning container' : 'Warning container empty (success)'
        };
      }
      
      console.log(`[Browser] No warning container in last message`);
      return { 
        found: false, 
        visible: false, 
        chatItemCount: afterCount,
        beforeCount,
        afterCount,
        reason: 'No warning container found' 
      };
    }, messageCountBeforeSend);
    
    console.log(`[Engagement] Failure icon check result:`, hasFailureIcon);
    
    if (hasFailureIcon.found && hasFailureIcon.visible) {
      console.log(`[Engagement] ❌ DM failed to send - failure icon detected (user may have privacy settings blocking DMs)`);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'Message failed to send - user privacy settings may block DMs' };
    }
    
    console.log(`[Engagement] ✅ No failure icon detected - DM sent successfully to @${username}`);
    
    console.log(`[Engagement] ✅ DM sent to @${username}`);
    
    // Remove navigation listener before returning
    page.removeAllListeners('framenavigated');
    
    return { success: true };
    
  } catch (error) {
    console.error(`[Engagement] Error sending DM to @${username}:`, error);
    
    // Remove navigation listener before returning
    page.removeAllListeners('framenavigated');
    
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Post a comment reply on a TikTok video
 */
export async function postCommentReply(
  page: Page,
  videoUrl: string,
  commentText: string,
  targetUsername: string
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[Engagement] 📝 postCommentReply() called for video: ${videoUrl}`);
    console.log(`[Engagement] 🎯 Looking for comment from @${targetUsername}`);
    
    // CRITICAL: Check current URL and navigate if needed
    const currentUrl = page.url();
    console.log(`[Engagement] 🔍 Current URL before navigation check: ${currentUrl}`);
    console.log(`[Engagement] 🎯 Target video URL: ${videoUrl}`);
    
    // Check if we're on a video page (ANY video page)
    if (!currentUrl.includes('/video/')) {
      console.log(`[Engagement] ⚠️ NOT on video page! Current page: ${currentUrl}`);
      console.log(`[Engagement] 🚀 Navigating back to video: ${videoUrl}`);
      
      try {
        await page.goto(videoUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        console.log(`[Engagement] ✅ Navigation completed (URL changed)`);
        
        // CRITICAL: Wait for actual video content to render (not just URL change)
        console.log(`[Engagement] ⏳ Waiting for video page content to render...`);
        await page.waitForSelector('[data-e2e="browse-video"], [data-e2e="comment-level-1"], video', {
          timeout: 10000
        });
        console.log(`[Engagement] ✅ Video content detected!`);
        
        const afterNavUrl = page.url();
        console.log(`[Engagement] 🔍 URL after navigation: ${afterNavUrl}`);
      } catch (navError) {
        console.error(`[Engagement] ❌ Navigation or content loading failed:`, navError);
        return { success: false, error: 'Failed to load video page content' };
      }
    } else {
      console.log(`[Engagement] ✅ Already on video page, no navigation needed`);
    }
    
    // CRITICAL: Wait for comment button to be available before checking comments
    console.log(`[Engagement] ⏳ Waiting for comment button to render...`);
    try {
      await page.waitForSelector('[data-e2e="comment-icon"]', {
        timeout: 10000,
        visible: true
      });
      console.log(`[Engagement] ✅ Comment button is now visible`);
    } catch (btnWait) {
      console.log(`[Engagement] ⚠️ Comment button did not appear, checking if comments already open...`);
    }
    
    // Now check if comments are already visible or if we need to click button
    const commentsCheck = await page.evaluate(() => {
      const comments = document.querySelectorAll('[data-e2e="comment-level-1"]');
      const commentButton = document.querySelector('[data-e2e="comment-icon"]');
      return {
        commentsVisible: comments.length > 0,
        commentButtonExists: !!commentButton
      };
    });
    
    console.log(`[Engagement] 🔍 Comments panel check:`, commentsCheck);
    
    if (!commentsCheck.commentsVisible && commentsCheck.commentButtonExists) {
      console.log(`[Engagement] 📂 Comments not visible, clicking comment button to open panel...`);
      try {
        // Click the comment button
        const clickResult = await page.evaluate(() => {
          const commentIcon = document.querySelector('[data-e2e="comment-icon"]');
          if (commentIcon) {
            const button = commentIcon.closest('button');
            if (button) {
              (button as HTMLElement).click();
              return { clicked: true, buttonText: button.getAttribute('aria-label') };
            }
          }
          return { clicked: false, buttonText: null };
        });
        console.log(`[Engagement] 🖱️ Comment button click result:`, clickResult);
        
        if (!clickResult.clicked) {
          console.log(`[Engagement] ❌ Failed to click comment button`);
          return { success: false, error: 'Could not click comment button' };
        }
        
        // Wait longer for comments section to animate open
        await new Promise(resolve => setTimeout(resolve, 3000)); // Increased from 2s to 3s
        
        // Wait for comments to load (try multiple selectors)
        try {
          await page.waitForSelector('[data-e2e="comment-level-1"]', { 
            timeout: 8000,
            visible: true
          });
          console.log(`[Engagement] ✅ Comments panel opened and comments loaded!`);
        } catch (waitErr) {
          // Check if any comments loaded at all
          const commentCount = await page.evaluate(() => {
            return document.querySelectorAll('[data-e2e="comment-level-1"]').length;
          });
          console.log(`[Engagement] ⚠️ Wait timeout, but found ${commentCount} comments in DOM`);
          if (commentCount === 0) {
            return { success: false, error: 'No comments loaded after clicking button' };
          }
        }
      } catch (openError) {
        console.log(`[Engagement] ⚠️ Could not open comments panel:`, openError);
        return { success: false, error: 'Failed to open comments section' };
      }
    } else if (commentsCheck.commentsVisible) {
      console.log(`[Engagement] ✅ Comments already visible, no need to click button`);
    } else {
      console.log(`[Engagement] ⚠️ Comment button not found on page`);
    }
    
    // CRITICAL: Find the specific comment from targetUsername and click its Reply button
    console.log(`[Engagement] 🔍 Looking for @${targetUsername}'s comment...`);
    
    // Wait for comments to load
    console.log(`[Engagement] Waiting for comments to load...`);
    try {
      await page.waitForSelector('[data-e2e="comment-level-1"], [data-e2e="comment-item"]', { 
        timeout: 10000 
      });
      console.log(`[Engagement] ✅ Comments loaded`);
    } catch (waitErr) {
      console.log(`[Engagement] ⚠️ Timeout waiting for comments, continuing anyway...`);
    }
    
    // CRITICAL: Scroll comments with mouse hover to load ALL comments before searching for target user
    console.log(`[Engagement] 📜 Scrolling comments to load all comments...`);
    
    // Get total comment count and container position
    const scrollInfo = await page.evaluate(() => {
      // CRITICAL: Detect browser zoom level
      // When browser is zoomed out, all coordinates are scaled by the zoom factor
      const zoom = window.devicePixelRatio || 1;
      const computedZoom = parseFloat(getComputedStyle(document.body).zoom || '1');
      const effectiveZoom = zoom / computedZoom;
      
      console.log(`[Browser] Zoom level: ${effectiveZoom} (devicePixelRatio: ${zoom}, body zoom: ${computedZoom})`);
      
      // Get total comment count from the UI
      const commentsCountEl = document.querySelector('[class*="DivCommentCountContainer"]') ||
                             document.querySelector('[data-e2e="comment-count"]') ||
                             document.querySelector('[data-e2e="browse-comment-count"]') ||
                             document.querySelector('[class*="comment-count"]') ||
                             document.querySelector('[class*="CommentCount"]');
      const totalComments = parseInt(commentsCountEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);
      
      // CRITICAL: Find the COMMENTS panel scrollable container, NOT the video sidebar
      // Look for the actual comment list container with the specific class pattern
      const containers = Array.from(document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]'));
      
      console.log(`[Browser] Found ${containers.length} potential comment containers`);
      
      const container = containers.find(el => {
        const rect = el.getBoundingClientRect();
        // Comments panel is wider (typically 300-400px), video sidebar is narrow (~72px)
        // With zoom, dimensions scale accordingly
        const hasGoodDimensions = rect.width > 150 && rect.height > 150;
        
        if (hasGoodDimensions) {
          console.log(`[Browser] Container candidate:`, {
            class: el.className.substring(0, 50),
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top
          });
        }
        
        return hasGoodDimensions;
      }) as HTMLElement | undefined;
      
      if (container) {
        const rect = container.getBoundingClientRect();
        
        // Position mouse in the center horizontally
        const x = rect.left + rect.width / 2;
        
        // Position mouse in visible area vertically
        // Account for any scroll offset and keep within viewport
        const viewportHeight = window.innerHeight;
        const safeTopOffset = 200; // pixels from top of container
        const y = Math.min(rect.top + safeTopOffset, viewportHeight * 0.6);
        
        console.log(`[Browser] Selected container:`, {
          class: container.className,
          rectLeft: rect.left,
          rectTop: rect.top,
          rectWidth: rect.width,
          rectHeight: rect.height,
          calculatedX: x,
          calculatedY: y,
          viewportHeight: viewportHeight
        });
        
        return {
          found: true,
          x: x,
          y: y,
          totalComments,
          zoom: effectiveZoom,
          containerClass: container.className,
          rectInfo: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        };
      }
      
      console.log(`[Browser] ❌ No suitable comment container found`);
      return { found: false, totalComments, zoom: effectiveZoom };
    });
    
    console.log(`[Engagement] 📊 Total comments on video: ${scrollInfo.totalComments}`);
    console.log(`[Engagement] 🔍 Browser zoom level: ${scrollInfo.zoom || 'unknown'}`);
    
    if (scrollInfo.found) {
      console.log(`[Engagement] ✅ Scrollable container found: ${scrollInfo.containerClass?.substring(0, 60)}...`);
      console.log(`[Engagement] 📐 Container rect:`, scrollInfo.rectInfo);
      console.log(`[Engagement] 🖱️ Calculated mouse position: (${Math.round(scrollInfo.x)}, ${Math.round(scrollInfo.y)})`);
      
      // Move mouse to hover over the SCROLLABLE container
      await page.mouse.move(scrollInfo.x, scrollInfo.y);
      console.log(`[Engagement] ✅ Mouse positioned over comments section`);
      await new Promise(resolve => setTimeout(resolve, 1500)); // Give time for hover to register
      
      let loadedComments = 0;
      let scrollAttempts = 0;
      const maxScrollAttempts = 50; // Safety limit
      let noChangeCount = 0;
      
      // Keep scrolling until we've loaded all comments
      while (loadedComments < scrollInfo.totalComments && scrollAttempts < maxScrollAttempts) {
        scrollAttempts++;
        
        const beforeCount = loadedComments;
        
        // Use Puppeteer's trusted mouse wheel event (mouse already positioned over scrollable container)
        await page.mouse.wheel({ deltaY: 800 });
        
        // Wait 2 seconds for TikTok's lazy loading (takes about 1 second to load new comments)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Count after scrolling
        loadedComments = await page.evaluate(() => {
          return document.querySelectorAll('[data-e2e="comment-level-1"]').length;
        });
        
        const increased = loadedComments > beforeCount;
        const percentage = Math.round((loadedComments / scrollInfo.totalComments) * 100);
        console.log(`[Engagement] 🔄 Scroll ${scrollAttempts}: ${beforeCount} → ${loadedComments}/${scrollInfo.totalComments} (${percentage}%) ${increased ? '✅ (NEW!)' : '⚠️ (no change)'}`);
        
        // Stop if we've loaded all comments
        if (loadedComments >= scrollInfo.totalComments) {
          console.log(`[Engagement] ✅ All comments loaded! (${loadedComments}/${scrollInfo.totalComments})`);
          break;
        }
        
        // Track consecutive failures - be more patient (5 attempts instead of 3)
        if (!increased) {
          noChangeCount++;
          if (noChangeCount >= 5) {
            console.log(`[Engagement] ⚠️ No new comments after ${noChangeCount} scroll attempts - stopping at ${loadedComments}/${scrollInfo.totalComments} (${percentage}%)`);
            break;
          }
        } else {
          noChangeCount = 0; // Reset on success
        }
      }
      
      if (scrollAttempts >= maxScrollAttempts) {
        console.log(`[Engagement] ⚠️ Reached max scroll attempts (${maxScrollAttempts}), proceeding with ${loadedComments} comments loaded`);
      }
      
      console.log(`[Engagement] ✅ Scrolling complete, now searching for @${targetUsername}...`);
    } else {
      console.log(`[Engagement] ⚠️ Could not find comments container for scrolling, proceeding with search...`);
    }
    
    // Find the specific comment from targetUsername
    const targetCommentIndex = await page.evaluate((username) => {
      // CRITICAL: [data-e2e="comment-level-1"] is a SPAN with just the comment text
      // We need the parent DIV that contains the full comment structure (username link + text + actions)
      const commentTextSpans = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"]'));
      
      // Navigate up to find the DivCommentContentWrapper container
      const comments = commentTextSpans.map(span => {
        // Go up to parent DIV (usually DivCommentContentWrapper)
        let container = span.parentElement;
        // Look for a DIV with "Comment" in the class name
        while (container && (!container.className || !container.className.includes('Comment'))) {
          container = container.parentElement;
        }
        return container || span.parentElement;
      }).filter(el => el !== null);
      
      console.log(`[Browser] Searching ${comments.length} comments for @${username}...`);
      console.log(`[Browser] Comment container class names:`, comments.slice(0, 2).map(c => c?.className?.substring(0, 50)).join(' | '));

      const foundUsernames: string[] = []; // Track all found usernames for debugging
      
      // Find the comment from this specific user
      for (let i = 0; i < comments.length; i++) {
        const comment = comments[i];
        if (!comment) continue;
        
        // Try multiple methods to find the username
        let commentUsername = '';
        
        // Method 1: Look for ANY <a> tag with href containing /@
        const allLinks = comment.querySelectorAll('a[href*="/@"]');
        if (allLinks.length > 0) {
          // Get the FIRST link (should be the username link)
          const firstLink = allLinks[0] as HTMLAnchorElement;
          const href = firstLink.getAttribute('href') || '';
          const match = href.match(/\/@([^/?]+)/);
          if (match) {
            commentUsername = match[1];
          }
        }
        
        // Method 2: Look for username in data-e2e="comment-username-*" wrapper (alternative)
        if (!commentUsername) {
          const usernameWrapper = comment.querySelector('[data-e2e="comment-username-1"]');
          if (usernameWrapper) {
            const link = usernameWrapper.querySelector('a[href*="/@"]');
            if (link) {
              const href = link.getAttribute('href') || '';
              const match = href.match(/\/@([^/?]+)/);
              if (match) {
                commentUsername = match[1];
              }
            }
          }
        }
        
        // Clean up the username
        commentUsername = commentUsername.replace('@', '').trim().toLowerCase();
        foundUsernames.push(commentUsername);
        
        if (commentUsername && commentUsername === username.toLowerCase()) {
          console.log(`[Browser] ✅ Found @${username} at comment index ${i}`);
          return i; // Return the index of the matching comment
        }
      }
      
      console.log(`[Browser] ❌ Could not find @${username} in any of the ${comments.length} comments`);
      console.log(`[Browser] 📋 Found usernames:`, foundUsernames.slice(0, 10).join(', '));
      return -1; // Not found
    }, targetUsername);
    
    if (targetCommentIndex === -1) {
      console.log(`[Engagement] ❌ Could not find comment from @${targetUsername}`);
      return { success: false, error: `Comment from @${targetUsername} not found on page` };
    }
    
    console.log(`[Engagement] ✅ Found @${targetUsername}'s comment at index ${targetCommentIndex}`);
    
    const replyButtonInfo = await page.evaluate(() => {
      // First, try to find reply buttons with data-e2e attribute (e.g., data-e2e="comment-reply-1")
      let replyButtons = Array.from(document.querySelectorAll('[data-e2e^="comment-reply"]'));
      
      // Fallback: look for <p> elements with role="button" and "Reply" text inside DivReplyTriggerWrapper
      const replyWrappers = Array.from(document.querySelectorAll('[class*="DivReplyTriggerWrapper"]'));
      const replyParagraphs = Array.from(document.querySelectorAll('p.TUXText[role="button"][aria-label="Reply"]'));
      
      // Also look for any elements with "Reply" text
      const allElements = Array.from(document.querySelectorAll('[role="button"]'));
      const replyTextButtons = allElements.filter(el => el.textContent?.trim() === 'Reply');
      
      // DIAGNOSTICS: What DO we have on the page?
      const allComments = document.querySelectorAll('[data-e2e="comment-level-1"]');
      const allDataE2E = Array.from(document.querySelectorAll('[data-e2e]')).map(el => el.getAttribute('data-e2e'));
      const allRoleButtons = Array.from(document.querySelectorAll('[role="button"]')).map(el => el.textContent?.trim());
      
      return {
        dataE2ECount: replyButtons.length,
        wrapperCount: replyWrappers.length,
        replyParagraphCount: replyParagraphs.length,
        textButtonCount: replyTextButtons.length,
        diagnostics: {
          totalComments: allComments.length,
          dataE2EAttributes: allDataE2E.slice(0, 30),
          roleButtonTexts: allRoleButtons.slice(0, 15)
        }
      };
    });
    
    console.log(`[Engagement] Reply button search results:`, replyButtonInfo);
    console.log(`[Engagement]   - Found ${replyButtonInfo.dataE2ECount} buttons with [data-e2e^="comment-reply"]`);
    console.log(`[Engagement]   - Found ${replyButtonInfo.wrapperCount} DivReplyTriggerWrapper elements`);
    console.log(`[Engagement]   - Found ${replyButtonInfo.replyParagraphCount} <p> tags with aria-label="Reply"`);
    console.log(`[Engagement]   - Found ${replyButtonInfo.textButtonCount} role="button" elements with "Reply" text`);
    
    if (replyButtonInfo.diagnostics) {
      console.log(`[Engagement] 🔍 DIAGNOSTICS:`);
      console.log(`  - Total comments on page: ${replyButtonInfo.diagnostics.totalComments}`);
      console.log(`  - data-e2e attributes:`, replyButtonInfo.diagnostics.dataE2EAttributes);
      console.log(`  - role="button" texts:`, replyButtonInfo.diagnostics.roleButtonTexts);
    }
    
    const replyClicked = await page.evaluate((commentIndex) => {
      // Method 1: Try data-e2e attribute (e.g., data-e2e="comment-reply-1")
      let replyButtons = Array.from(document.querySelectorAll('[data-e2e^="comment-reply"]'));
      
      if (replyButtons.length > commentIndex) {
        const targetReply = replyButtons[commentIndex] as HTMLElement;
        targetReply.click();
        return { success: true, method: 'data-e2e attribute' };
      }
      
      // Method 2: Try <p> tag with aria-label="Reply" (matches actual HTML)
      const replyParagraphs = Array.from(document.querySelectorAll('p.TUXText[role="button"][aria-label="Reply"]'));
      if (replyParagraphs.length > commentIndex) {
        (replyParagraphs[commentIndex] as HTMLElement).click();
        return { success: true, method: 'p[aria-label="Reply"]' };
      }
      
      // Method 3: Look inside DivReplyTriggerWrapper for <p> with "Reply" text
      const replyWrappers = Array.from(document.querySelectorAll('[class*="DivReplyTriggerWrapper"]'));
      if (replyWrappers.length > commentIndex) {
        const targetWrapper = replyWrappers[commentIndex];
        const replyText = targetWrapper.querySelector('p[role="button"]') as HTMLElement;
        if (replyText && replyText.textContent?.trim() === 'Reply') {
          replyText.click();
          return { success: true, method: 'DivReplyTriggerWrapper > p' };
        }
      }
      
      // Method 4: Any role="button" with "Reply" text (collect all, then select by index)
      const allElements = Array.from(document.querySelectorAll('[role="button"]'));
      const replyTextButtons = allElements.filter(el => el.textContent?.trim() === 'Reply');
      if (replyTextButtons.length > commentIndex) {
        (replyTextButtons[commentIndex] as HTMLElement).click();
        return { success: true, method: 'role="button" with Reply text' };
      }
      
      return { success: false };
    }, targetCommentIndex);
    
    console.log(`[Engagement] Reply button click result:`, replyClicked);
    
    if (!replyClicked.success) {
      console.log(`[Engagement] ❌ Could not find or click Reply button - tried all methods`);
      return { success: false, error: 'Reply button not found' };
    }
    
    console.log(`[Engagement] ✅ Reply button clicked successfully using method: ${replyClicked.method}`);
    
    // Wait for the reply input panel to appear after clicking Reply
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Find and focus the comment input - use Puppeteer's native typing to trigger React events properly
    const inputSelector = await page.evaluate(() => {
      // Try different selectors for the comment input
      const selectors = [
        '.comment-panel-input [contenteditable="true"]',
        '[data-e2e="comment-input"] [contenteditable="true"]',
        '[data-e2e="comment-text"] [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
      ];
      
      for (const selector of selectors) {
        const input = document.querySelector(selector) as HTMLElement;
        if (input) {
          // Focus the element to prepare for typing
          input.focus();
          return selector;
        }
      }
      return null;
    });
    
    if (!inputSelector) {
      return { success: false, error: 'Comment input box not found after clicking Reply' };
    }
    
    console.log(`[Engagement] Found comment input with selector: ${inputSelector}`);
    
    // Use Puppeteer's type() method which properly simulates keyboard events
    // This triggers React's onChange handlers that setting innerText doesn't
    try {
      await page.type(inputSelector, commentText, { delay: 50 }); // 50ms delay between keystrokes for more natural typing
      console.log(`[Engagement] Text entered into comment input using native typing`);
    } catch (typeError) {
      console.log(`[Engagement] ❌ Error typing into comment input:`, typeError);
      return { success: false, error: 'Failed to type into comment input' };
    }
    
    // Wait for Post button to become enabled (disabled attribute removed)
    console.log(`[Engagement] Waiting for Post button to become enabled...`);
    try {
      await page.waitForFunction(
        () => {
          const postButton = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement;
          return postButton && !postButton.disabled && !postButton.hasAttribute('disabled');
        },
        { timeout: 5000 }
      );
      console.log(`[Engagement] ✅ Post button is now enabled!`);
    } catch (waitError) {
      console.log(`[Engagement] ⚠️ Post button did not become enabled within 5 seconds`);
      return { success: false, error: 'Post button remained disabled after typing comment' };
    }
    
    // Small delay to ensure button is fully ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Click post button (data-e2e="comment-post")
    console.log(`[Engagement] Clicking Post button...`);
    const posted = await page.evaluate(() => {
      const postButton = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement;
      if (postButton && !postButton.disabled && !postButton.hasAttribute('disabled')) {
        postButton.click();
        return { success: true, wasDisabled: false };
      }
      return { success: false, wasDisabled: postButton?.disabled || false };
    });
    
    if (!posted.success) {
      console.log(`[Engagement] ❌ Post button still disabled:`, posted);
      return { success: false, error: 'Post button not found or still disabled' };
    }
    
    console.log(`[Engagement] ✅ Post button clicked!`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`[Engagement] ✅ Comment posted`);
    return { success: true };
    
  } catch (error) {
    console.error(`[Engagement] Error posting comment:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Main engagement function: Try DM first, fallback to comment if DM fails
 */
export async function engageWithUser(
  page: Page,
  userId: number,
  accountId: number,
  username: string,
  videoUrl: string,
  dmMessage: string,
  commentMessage: string
): Promise<EngagementResult> {
  
  // Check if already contacted
  const alreadyContacted = await hasContactedUser(userId, username);
  if (alreadyContacted) {
    console.log(`[Engagement] ⏭️ Skipping @${username} - already contacted previously`);
    return { username, method: 'skipped', success: false, error: 'Already contacted' };
  }
  
  console.log(`[Engagement] 📤 Attempting to engage with @${username}...`);
  console.log(`[Engagement] Step 1: Trying DM first...`);
  
  // Try DM first
  const dmResult = await tryToSendDM(page, username, dmMessage);
  
  if (dmResult.success) {
    console.log(`[Engagement] ✅ DM successfully sent to @${username}`);
    await recordContact(userId, username, 'dm', accountId, videoUrl);
    console.log(`[Engagement] 💾 Added @${username} to contacted_users table (via DM)`);
    await logActivity(userId, accountId, 'dm_sent', username, videoUrl, dmMessage, true);
    console.log(`[Engagement] 📝 Logged activity for @${username}`);
    return { username, method: 'dm', success: true };
  }
  
  // DM failed, fallback to comment
  console.log(`[Engagement] ❌ DM failed for @${username}: ${dmResult.error}`);
  console.log(`[Engagement] Step 2: Falling back to comment reply...`);
  
  const commentResult = await postCommentReply(page, videoUrl, commentMessage, username);
  
  if (commentResult.success) {
    console.log(`[Engagement] ✅ Comment reply successfully posted for @${username}`);
    await recordContact(userId, username, 'comment', accountId, videoUrl);
    console.log(`[Engagement] 💾 Added @${username} to contacted_users table (via comment)`);
    await logActivity(userId, accountId, 'comment_posted', username, videoUrl, commentMessage, true);
    console.log(`[Engagement] 📝 Logged activity for @${username}`);
    return { username, method: 'comment', success: true };
  }
  
  // Both failed
  console.log(`[Engagement] ❌ Comment reply also failed for @${username}: ${commentResult.error}`);
  console.log(`[Engagement] ⚠️ Unable to engage with @${username} - both DM and comment failed`);
  await logActivity(userId, accountId, 'comment_posted', username, videoUrl, commentMessage, false, commentResult.error);
  console.log(`[Engagement] 📝 Logged failed activity for @${username}`);
  return { username, method: 'comment', success: false, error: commentResult.error };
}
