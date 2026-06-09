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
  actionType: 'dm_sent' | 'comment_posted' | 'affiliate_dm_sent' | 'affiliate_comment_posted',
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
 * Returns rateLimitDetected=true if TikTok rate limit message appears
 */
export async function tryToSendDM(
  page: Page,
  username: string,
  message: string
): Promise<{ success: boolean; error?: string; rateLimitDetected?: boolean }> {
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
    // Step 2: Wait for profile page content to load - specifically the Message button
    console.log(`[Engagement] 🔍 Step 3/5: Waiting for Message button to load...`);
    try {
      // CRITICAL: Wait for the Message button specifically (not just any profile element)
      // TikTok dynamically renders buttons, so we need to wait for this exact element
      await page.waitForSelector('[data-e2e="message-button"]', { 
        timeout: 30000,
        visible: true
      });
      console.log(`[Engagement] ✅ Message button found and visible`);
    } catch (waitErr) {
      console.log(`[Engagement] ⚠️ Message button not found within 30 seconds - user may have DMs disabled`);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'Message button not found - user may have DMs disabled' };
    }
    
    // Add small delay for TikTok's dynamic rendering to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 3: Verify the Message button is still there
    console.log(`[Engagement] 🔍 Step 3/5: Verifying Message button with selector [data-e2e="message-button"]...`);
    
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
      // CRITICAL: Find the Message button first, then click its parent <a> tag
      // This ensures we get the user-specific URL (/messages?u=USER_ID), not generic /messages
      const btn = document.querySelector('[data-e2e="message-button"]') as HTMLElement;
      if (btn) {
        // Look for parent <a> tag (the actual navigation link)
        const parentLink = btn.closest('a');
        if (parentLink) {
          const href = parentLink.getAttribute('href') || '';
          console.log(`[Browser] Found Message button with parent link: ${href}`);
          
          // Verify it's a user-specific messages link (should contain user parameter)
          if (href.includes('/messages') && href.includes('?')) {
            console.log('[Browser] Clicking parent <a> tag with user-specific URL');
            (parentLink as HTMLElement).click();
            return { method: 'parent-link', clicked: true, href };
          } else {
            console.log('[Browser] Parent link does not have user parameter, clicking button directly');
            btn.click();
            return { method: 'button-direct', clicked: true, href };
          }
        } else {
          console.log('[Browser] No parent <a> tag found, clicking button directly');
          btn.click();
          return { method: 'data-e2e', clicked: true, href: 'no-parent-link' };
        }
      }
      
      // Fallback 1: Look for any <a> tag that wraps a Message button
      const allLinks = Array.from(document.querySelectorAll('a[href*="/messages"]'));
      for (const link of allLinks) {
        const buttonInside = link.querySelector('button');
        if (buttonInside && buttonInside.textContent?.toLowerCase().includes('message')) {
          const href = link.getAttribute('href') || '';
          console.log(`[Browser] Found Message link via button text: ${href}`);
          (link as HTMLElement).click();
          return { method: 'link-with-button', clicked: true, href };
        }
      }
      
      // Fallback 2: Find button by text (last resort)
      const allButtons = Array.from(document.querySelectorAll('button'));
      const messageBtn = allButtons.find(b => b.textContent?.toLowerCase().includes('message'));
      if (messageBtn) {
        console.log('[Browser] Found button via text search, clicking...');
        (messageBtn as HTMLElement).click();
        return { method: 'text', clicked: true, href: 'button-only' };
      }
      
      return { method: 'none', clicked: false, href: 'not-found' };
    });
    
    console.log(`[Engagement] Click result:`, clickResult);
    
    if (!clickResult.clicked) {
      console.log(`[Engagement] ❌ Failed to click Message button - element not found`);
      page.removeAllListeners('framenavigated');
      return { success: false, error: 'Could not find Message button to click' };
    }
    
    // Wait for navigation to complete
    await navigationPromise;
    
    const currentUrl = page.url();
    console.log(`[Engagement] ✅ Step 4/5: Message button clicked (${clickResult.method}), current URL: ${currentUrl}`);
    
    // Verify we're on a user-specific messages page (not generic messages inbox)
    if (!currentUrl.includes('?') && currentUrl.includes('/messages')) {
      console.log(`[Engagement] ⚠️ WARNING: Landed on generic /messages page without user parameter!`);
      console.log(`[Engagement] This means we clicked wrong element. Expected URL like: /messages?u=USER_ID`);
      console.log(`[Engagement] Clicked element href was: ${clickResult.href}`);
      
      // Try to recover by navigating to user's profile and retrying
      page.removeAllListeners('framenavigated');
      return { success: false, error: 'Navigated to generic messages inbox instead of user conversation - Message button may have wrong link' };
    }
    
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
      await page.waitForSelector('[data-e2e="message-send"], [data-e2e="dm-new-send-btn"]', {
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
      await page.click('[data-e2e="message-send"], [data-e2e="dm-new-send-btn"]');
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
    
    console.log(`[Engagement] ✅ No failure icon detected - checking for rate limit message...`);
    
    // PHASE 2: Check for rate limit message
    const rateLimitDetected = await page.evaluate(() => {
      // Search inside DivChatMain container for rate limit text
      const chatMainContainer = document.querySelector('.css-2p0m0i-7937d88b--DivChatMain, [class*="DivChatMain"]');
      
      if (chatMainContainer) {
        const containerText = chatMainContainer.textContent || '';
        const hasRateLimitMessage = containerText.includes('You are sending messages too fast. Take a rest.');
        
        if (hasRateLimitMessage) {
          console.log('[Browser] ⚠️ RATE LIMIT DETECTED: "You are sending messages too fast. Take a rest."');
          return true;
        }
      }
      
      return false;
    });
    
    if (rateLimitDetected) {
      console.log(`[Engagement] ⚠️ RATE LIMITED - TikTok blocked message sending for @${username}`);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      // Return special error code for rate limiting
      return { success: false, error: 'RATE_LIMITED', rateLimitDetected: true } as any;
    }
    
    console.log(`[Engagement] ✅ No rate limit detected - DM sent successfully to @${username}`);
    
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
    
    // Scroll/search strategy: try immediate username-scoped click, then sweep up and down.
    console.log(`[Engagement] 📜 Locating @${targetUsername} and clicking the Reply button on that exact comment...`);

    const scrollInfo = await page.evaluate(() => {
      const zoom = window.devicePixelRatio || 1;
      const computedZoom = parseFloat(getComputedStyle(document.body).zoom || '1');
      const effectiveZoom = zoom / computedZoom;

      const commentsCountEl = document.querySelector('[class*="DivCommentCountContainer"]') ||
                             document.querySelector('[data-e2e="comment-count"]') ||
                             document.querySelector('[data-e2e="browse-comment-count"]') ||
                             document.querySelector('[class*="comment-count"]') ||
                             document.querySelector('[class*="CommentCount"]');
      const totalComments = parseInt(commentsCountEl?.textContent?.replace(/[^0-9]/g, '') || '0', 10);

      const containers = Array.from(document.querySelectorAll('[class*="DivCommentListContainer"], [class*="DivCommentMain"], [class*="DivScrollingContentContainer"]'));
      const container = containers.find(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 150 && rect.height > 150;
      }) as HTMLElement | undefined;

      if (!container) {
        return { found: false, totalComments, zoom: effectiveZoom };
      }

      const rect = container.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = Math.min(rect.top + 200, window.innerHeight * 0.6);

      return {
        found: true,
        x,
        y,
        totalComments,
        zoom: effectiveZoom,
        containerClass: container.className,
        rectInfo: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      };
    });

    console.log(`[Engagement] 📊 Total comments on video: ${scrollInfo.totalComments}`);
    console.log(`[Engagement] 🔍 Browser zoom level: ${scrollInfo.zoom || 'unknown'}`);

    if (scrollInfo.found) {
      await page.mouse.move(scrollInfo.x, scrollInfo.y);
      console.log(`[Engagement] ✅ Mouse positioned over comments section`);
      await new Promise(resolve => setTimeout(resolve, 1200));
    } else {
      console.log(`[Engagement] ⚠️ Could not find comments container, will still attempt visible-comment match`);
    }

    const tryClickReplyForUser = async (): Promise<{ success: boolean; method?: string; visibleCount: number; foundUsernames: string[] }> => {
      return page.evaluate((username) => {
        const normalizedTarget = String(username || '').replace(/^@/, '').trim().toLowerCase();

        const commentTextSpans = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"]'));
        const commentContainers = commentTextSpans.map(span => {
          let container: Element | null = span.parentElement;
          while (container && !(container.className || '').toString().includes('Comment')) {
            container = container.parentElement;
          }
          return container || span.parentElement;
        }).filter(Boolean) as Element[];

        const foundUsernames: string[] = [];

        for (const comment of commentContainers) {
          const userLink = comment.querySelector('a[href*="/@"]') as HTMLAnchorElement | null;
          const href = userLink?.getAttribute('href') || '';
          const usernameMatch = href.match(/\/@([^/?]+)/);
          const found = String(usernameMatch?.[1] || '').replace(/^@/, '').trim().toLowerCase();
          if (found) {
            foundUsernames.push(found);
          }

          if (!found || found !== normalizedTarget) {
            continue;
          }

          // Click Reply only within this matched comment container.
          const inContainerReply = comment.querySelector('[data-e2e^="comment-reply"], p.TUXText[role="button"][aria-label="Reply"], [class*="DivReplyTriggerWrapper"] [role="button"]') as HTMLElement | null;
          if (inContainerReply) {
            inContainerReply.click();
            return { success: true, method: 'scoped-to-matched-comment', visibleCount: commentContainers.length, foundUsernames };
          }

          // Last fallback: find nearest role button with Reply text inside this comment.
          const replyRoleButton = Array.from(comment.querySelectorAll('[role="button"]')).find(el => el.textContent?.trim() === 'Reply') as HTMLElement | undefined;
          if (replyRoleButton) {
            replyRoleButton.click();
            return { success: true, method: 'scoped-role-button', visibleCount: commentContainers.length, foundUsernames };
          }

          return { success: false, method: 'matched-user-no-reply-control', visibleCount: commentContainers.length, foundUsernames };
        }

        return { success: false, visibleCount: commentContainers.length, foundUsernames };
      }, targetUsername);
    };

    const attemptedExpansionControls = new Set<string>();
    const expandVisibleReplyThreads = async (): Promise<{ candidates: number; clicked: number; sample: string[] }> => {
      const candidates = await page.evaluate(() => {
        const pattern = /^view\s+\d+\s+(repl(y|ies)|more)$/i;
        const results: Array<{ key: string; label: string }> = [];
        const seenKeys = new Set<string>();
        const seenTargets = new Set<HTMLElement>();

        const all = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')) as HTMLElement[];
        for (const el of all) {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          if (!pattern.test(text)) continue;

          const clickable =
            (el.closest('button') as HTMLElement | null) ||
            (el.closest('[role="button"]') as HTMLElement | null) ||
            null;

          if (!clickable || seenTargets.has(clickable)) continue;

          const rect = clickable.getBoundingClientRect();
          const style = window.getComputedStyle(clickable);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          if (!visible) continue;

          const commentRoot =
            clickable.closest('[data-e2e="comment-item"]') ||
            clickable.closest('[data-comment-ui-enabled="true"]') ||
            clickable.closest('[class*="DivCommentItemContainer"]');

          const anchorHref = (commentRoot?.querySelector('a[href*="/@"]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
          const commentAnchor = commentRoot?.getAttribute('data-e2e') || anchorHref || 'unknown';
          const rootFingerprint = ((commentRoot?.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 64).toLowerCase();
          const key = `${text.toLowerCase()}|${commentAnchor}|${rootFingerprint}`;

          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          seenTargets.add(clickable);
          results.push({ key, label: text.slice(0, 80) });
        }

        return results.slice(0, 12);
      });

      let clicked = 0;
      const sample: string[] = [];

      for (const candidate of candidates) {
        if (attemptedExpansionControls.has(candidate.key)) {
          continue;
        }

        const clickResult = await page.evaluate((targetKey) => {
          const pattern = /^view\s+\d+\s+(repl(y|ies)|more)$/i;
          const all = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')) as HTMLElement[];

          for (const el of all) {
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            if (!pattern.test(text)) continue;

            const target =
              (el.closest('button') as HTMLElement | null) ||
              (el.closest('[role="button"]') as HTMLElement | null) ||
              null;
            if (!target) continue;

            const rect = target.getBoundingClientRect();
            const style = window.getComputedStyle(target);
            const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            if (!visible) continue;

            const commentRoot =
              target.closest('[data-e2e="comment-item"]') ||
              target.closest('[data-comment-ui-enabled="true"]') ||
              target.closest('[class*="DivCommentItemContainer"]');

            const anchorHref = (commentRoot?.querySelector('a[href*="/@"]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
            const commentAnchor = commentRoot?.getAttribute('data-e2e') || anchorHref || 'unknown';
            const rootFingerprint = ((commentRoot?.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 64).toLowerCase();
            const key = `${text.toLowerCase()}|${commentAnchor}|${rootFingerprint}`;
            if (key !== targetKey) continue;

            try {
              const before = (target.innerText || target.textContent || '').trim().replace(/\s+/g, ' ');
              target.click();
              return { clicked: true, label: before.slice(0, 80) };
            } catch {
              return { clicked: false, label: text.slice(0, 80) };
            }
          }

          return { clicked: false, label: '' };
        }, candidate.key);

        attemptedExpansionControls.add(candidate.key);
        if (!clickResult.clicked) {
          continue;
        }

        clicked += 1;
        sample.push(clickResult.label || candidate.label);
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.floor(Math.random() * 1200)));
      }

      return { candidates: candidates.length, clicked, sample };
    };

    let replyClicked = await tryClickReplyForUser();
    console.log(`[Engagement] Initial scoped reply lookup:`, replyClicked);

    if (!replyClicked.success && scrollInfo.found) {
      const initialExpansion = await expandVisibleReplyThreads();
      if (initialExpansion.clicked > 0) {
        console.log(
          `[Engagement] Expanded visible reply threads before sweep: candidates=${initialExpansion.candidates}, clicked=${initialExpansion.clicked}, sample=${initialExpansion.sample.join(' | ') || 'none'}`
        );
        await new Promise(resolve => setTimeout(resolve, 900));
        replyClicked = await tryClickReplyForUser();
        console.log(`[Engagement] Post-expansion scoped reply lookup:`, replyClicked);
      }

      const directionPlan = [
        { name: 'up', deltaY: -900, attempts: 16 },
        { name: 'down', deltaY: 900, attempts: 30 }
      ];

      for (const phase of directionPlan) {
        console.log(`[Engagement] 🔄 Scanning comments (${phase.name}) for @${targetUsername}...`);
        for (let i = 1; i <= phase.attempts; i++) {
          await page.mouse.wheel({ deltaY: phase.deltaY });
          await new Promise(resolve => setTimeout(resolve, 1200));

          if (i % 3 === 0) {
            const expansionResult = await expandVisibleReplyThreads();
            if (expansionResult.clicked > 0) {
              console.log(
                `[Engagement]   ${phase.name} expansion after sweep ${i}: candidates=${expansionResult.candidates}, clicked=${expansionResult.clicked}, sample=${expansionResult.sample.join(' | ') || 'none'}`
              );
              await new Promise(resolve => setTimeout(resolve, 900));
            }
          }

          replyClicked = await tryClickReplyForUser();
          console.log(`[Engagement]   ${phase.name} sweep ${i}/${phase.attempts}: visible=${replyClicked.visibleCount}, success=${replyClicked.success}`);

          if (replyClicked.success) {
            break;
          }
        }

        if (replyClicked.success) {
          break;
        }
      }
    }

    console.log(`[Engagement] Reply button click result:`, replyClicked);
    
    if (!replyClicked.success) {
      console.log(`[Engagement] ❌ Could not find @${targetUsername} with a clickable Reply control after bidirectional scan`);
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
