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
      waitUntil: 'networkidle2',
      timeout: 15000
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
    
    // Check if message failed to send (failure icon appears within 2 seconds)
    console.log(`[Engagement] Checking if message sent successfully...`);
    try {
      await page.waitForSelector('.css-1ngp6v6-7937d88b--StyledIconFail', {
        timeout: 2000,
        visible: true
      });
      
      // Failure icon appeared - message didn't send (privacy settings, etc)
      console.log(`[Engagement] ❌ DM failed to send - failure icon detected (user may have privacy settings blocking DMs)`);
      
      // Remove navigation listener before returning
      page.removeAllListeners('framenavigated');
      
      return { success: false, error: 'Message failed to send - user privacy settings may block DMs' };
    } catch (timeoutError) {
      // Timeout means no failure icon appeared - message sent successfully!
      console.log(`[Engagement] ✅ No failure icon detected - DM sent successfully to @${username}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
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
  commentText: string
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[Engagement] 📝 postCommentReply() called for video: ${videoUrl}`);
    
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
          waitUntil: 'networkidle2',
          timeout: 15000
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
    
    // Verify we actually have video content (not inbox)
    const pageCheck = await page.evaluate(() => {
      return {
        hasComments: document.querySelectorAll('[data-e2e="comment-level-1"]').length > 0,
        hasInbox: document.querySelectorAll('[data-e2e="inbox-bar"]').length > 0,
        url: window.location.href
      };
    });
    
    console.log(`[Engagement] 🔍 Page content check:`, pageCheck);
    
    if (pageCheck.hasInbox && !pageCheck.hasComments) {
      console.log(`[Engagement] ❌ Still on inbox page after navigation! Actual URL: ${pageCheck.url}`);
      return { success: false, error: 'Page stuck on inbox after navigation' };
    }
    
    // Method 1: Try to click Reply button on the first comment (more natural for engagement)
    console.log(`[Engagement] 🔍 Looking for Reply button on comments...`);
    
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
    
    const replyClicked = await page.evaluate(() => {
      // Method 1: Try data-e2e attribute (e.g., data-e2e="comment-reply-1")
      let replyButtons = Array.from(document.querySelectorAll('[data-e2e^="comment-reply"]'));
      
      if (replyButtons.length > 0) {
        const firstReply = replyButtons[0] as HTMLElement;
        firstReply.click();
        return { success: true, method: 'data-e2e attribute' };
      }
      
      // Method 2: Try <p> tag with aria-label="Reply" (matches actual HTML)
      const replyParagraphs = Array.from(document.querySelectorAll('p.TUXText[role="button"][aria-label="Reply"]'));
      if (replyParagraphs.length > 0) {
        (replyParagraphs[0] as HTMLElement).click();
        return { success: true, method: 'p[aria-label="Reply"]' };
      }
      
      // Method 3: Look inside DivReplyTriggerWrapper for <p> with "Reply" text
      const replyWrappers = Array.from(document.querySelectorAll('[class*="DivReplyTriggerWrapper"]'));
      for (const wrapper of replyWrappers) {
        const replyText = wrapper.querySelector('p[role="button"]') as HTMLElement;
        if (replyText && replyText.textContent?.trim() === 'Reply') {
          replyText.click();
          return { success: true, method: 'DivReplyTriggerWrapper > p' };
        }
      }
      
      // Method 4: Any role="button" with "Reply" text
      const allElements = Array.from(document.querySelectorAll('[role="button"]'));
      const replyButton = allElements.find(el => el.textContent?.trim() === 'Reply');
      if (replyButton) {
        (replyButton as HTMLElement).click();
        return { success: true, method: 'role="button" with Reply text' };
      }
      
      return { success: false };
    });
    
    console.log(`[Engagement] Reply button click result:`, replyClicked);
    
    if (!replyClicked.success) {
      console.log(`[Engagement] ❌ Could not find or click Reply button - tried all methods`);
      return { success: false, error: 'Reply button not found' };
    }
    
    console.log(`[Engagement] ✅ Reply button clicked successfully using method: ${replyClicked.method}`);
    
    // Wait for the reply input panel to appear after clicking Reply
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Find the comment input (now uses .comment-panel-input class with Draft.js contenteditable)
    const inputFound = await page.evaluate((text) => {
      // Look for the comment panel input (appears after clicking Reply)
      const commentPanelInput = document.querySelector('.comment-panel-input [contenteditable="true"]') as HTMLElement;
      if (commentPanelInput) {
        // Clear and set content
        commentPanelInput.innerText = text;
        commentPanelInput.dispatchEvent(new Event('input', { bubbles: true }));
        commentPanelInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      
      // Fallback: try other selectors
      const selectors = [
        '[data-e2e="comment-input"] [contenteditable="true"]',
        '[data-e2e="comment-text"] [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
      ];
      
      for (const selector of selectors) {
        const input = document.querySelector(selector) as HTMLElement;
        if (input) {
          input.innerText = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, commentText);
    
    if (!inputFound) {
      return { success: false, error: 'Comment input box not found after clicking Reply' };
    }
    
    console.log(`[Engagement] Text entered into comment input`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Click post button (data-e2e="comment-post")
    const posted = await page.evaluate(() => {
      const postButton = document.querySelector('[data-e2e="comment-post"]') as HTMLButtonElement;
      if (postButton && !postButton.disabled && !postButton.hasAttribute('aria-disabled')) {
        postButton.click();
        return true;
      }
      return false;
    });
    
    if (!posted) {
      return { success: false, error: 'Post button not found or disabled' };
    }
    
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
  
  const commentResult = await postCommentReply(page, videoUrl, commentMessage);
  
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
