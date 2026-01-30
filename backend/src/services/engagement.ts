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
    
    // Step 1: Navigate to user's profile
    console.log(`[Engagement] 🔍 Step 2/5: Navigating to profile: https://www.tiktok.com/@${username}`);
    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: 'networkidle2',
      timeout: 15000
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(`[Engagement] ✅ Step 2/5: Profile page loaded: ${page.url()}`);
    
    // Step 2: Wait for profile page content to load (either Message button or Follow button)
    console.log(`[Engagement] 🔍 Step 3/5: Waiting for profile content to load...`);
    try {
      // Wait for either Message button, Follow button, or any profile action button to appear
      await page.waitForSelector('button[data-e2e="message-button"], button[data-e2e="follow-button"], button', { 
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
      console.log(`[Engagement] ❌ Step 3/5 FAILED: Message button not found`);
      if (messageButtonCheck.diagnostics) {
        console.log(`[Engagement] 🔍 DIAGNOSTICS:`);
        console.log(`  - Total buttons on page: ${messageButtonCheck.diagnostics.totalButtons}`);
        console.log(`  - Button texts:`, messageButtonCheck.diagnostics.buttonTexts);
        console.log(`  - data-e2e attributes found:`, messageButtonCheck.diagnostics.dataE2EAttributes);
        console.log(`  - Links with "message":`, messageButtonCheck.diagnostics.messageLinks);
      }
      return { success: false, error: 'Message button not found - user may have DMs disabled' };
    }
    
    if (messageButtonCheck.disabled) {
      console.log(`[Engagement] ❌ Step 3/5 FAILED: Message button is disabled`);
      return { success: false, error: 'Message button is disabled' };
    }
    
    console.log(`[Engagement] ✅ Step 3/5: Message button found (${messageButtonCheck.foundViaText ? 'via text match' : 'via data-e2e'})`);
    
    // Step 3: Click the message button (wrapped in <a> tag that navigates)
    console.log(`[Engagement] 🔍 Step 4/5: Clicking Message button (will navigate to /messages page)...`);
    
    // The button is wrapped in an <a> tag that navigates to /messages?u=...
    // So we need to wait for navigation
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
      console.log(`[Engagement] No navigation detected, button might open inline compose box`);
    });
    
    await page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="message-button"]') as HTMLElement;
      if (btn) {
        btn.click();
        return;
      }
      
      // Fallback: click the parent <a> tag
      const messageLink = document.querySelector('a[href*="/messages"]') as HTMLElement;
      if (messageLink) {
        messageLink.click();
        return;
      }
      
      // Fallback: find by text
      const allButtons = Array.from(document.querySelectorAll('button'));
      const messageBtn = allButtons.find(b => b.textContent?.toLowerCase().includes('message'));
      if (messageBtn) {
        (messageBtn as HTMLElement).click();
      }
    });
    
    // Wait for navigation to complete
    await navigationPromise;
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`[Engagement] ✅ Step 4/5: Message button clicked, current URL: ${page.url()}`);
    
    // Step 4: Check if DM input area appeared (on /messages page)
    console.log(`[Engagement] 🔍 Step 5/5: Checking if DM compose box appeared on messages page...`);
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
    
    console.log(`[Engagement] DM compose box check result:`, dmBoxCheck);
    
    if (!dmBoxCheck.bothFound) {
      if (!dmBoxCheck.inputAreaFound) {
        console.log(`[Engagement] ❌ Step 5/5 FAILED: [data-e2e="message-input-area"] not found`);
      }
      if (!dmBoxCheck.contentEditableFound && !dmBoxCheck.draftEditorContentFound) {
        console.log(`[Engagement] ❌ Step 5/5 FAILED: contenteditable div not found (neither inside message-input-area nor as .public-DraftEditor-content)`);
      }
      console.log(`[Engagement] Note: Found ${dmBoxCheck.totalContentEditables} total contenteditable elements on page`);
      console.log(`[Engagement] Current URL: ${page.url()}`);
      return { success: false, error: 'DM compose box did not appear - DMs may be blocked' };
    }
    
    console.log(`[Engagement] ✅ Step 5/5: DM compose box found! Now typing message...`);
    
    // Type the message into the Draft.js contenteditable div
    await page.evaluate((msg) => {
      // Try to find the contenteditable inside message-input-area first
      let contentEditable = document.querySelector('[data-e2e="message-input-area"] [contenteditable="true"]') as HTMLElement;
      
      // Fallback: find the Draft.js editor directly
      if (!contentEditable) {
        contentEditable = document.querySelector('.public-DraftEditor-content[contenteditable="true"]') as HTMLElement;
      }
      
      if (contentEditable) {
        // Clear any existing content
        contentEditable.innerText = '';
        
        // Set the message
        contentEditable.innerText = msg;
        
        // Trigger input event to update Draft.js state
        contentEditable.dispatchEvent(new Event('input', { bubbles: true }));
        contentEditable.dispatchEvent(new Event('change', { bubbles: true }));
        
        // Focus the element to ensure it's active
        contentEditable.focus();
      }
    }, message);
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Click send button (usually appears after typing)
    const sendClicked = await page.evaluate(() => {
      const sendSelectors = [
        '[data-e2e="message-send-button"]',
        '[data-e2e="message-input-area"] button[type="submit"]',
        '[data-e2e="message-input-area"] ~ button',
        'button[aria-label*="Send"]'
      ];
      
      for (const selector of sendSelectors) {
        const btn = document.querySelector(selector) as HTMLElement;
        if (btn && !btn.hasAttribute('disabled') && !btn.hasAttribute('aria-disabled')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (!sendClicked) {
      return { success: false, error: 'Send button not found or disabled' };
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`[Engagement] ✅ DM sent to @${username}`);
    return { success: true };
    
  } catch (error) {
    console.error(`[Engagement] Error sending DM to @${username}:`, error);
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
    console.log(`[Engagement] Posting comment on video: ${videoUrl}`);
    
    // Should already be on the video page, but navigate if needed
    if (!page.url().includes(videoUrl)) {
      await page.goto(videoUrl, {
        waitUntil: 'networkidle2',
        timeout: 15000
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
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
