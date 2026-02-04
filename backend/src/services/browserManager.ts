/**
 * Browser Manager - Abstraction layer for browser connections
 * Supports both legacy Chrome Debug mode and Incogniton profiles
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';

export type BrowserType = 'chrome_debug' | 'incogniton';

export interface BrowserConnection {
  browser: Browser;
  page: Page;
  type: BrowserType;
  profileId?: string; // For Incogniton
}

export interface TikTokAccount {
  id: number;
  account_id: string;
  browser_type: BrowserType;
  incogniton_profile_id?: string;
  session_data?: string; // JSON string
}

/**
 * Connect to a browser using Chrome Debug mode (legacy)
 */
async function connectChromeDebug(): Promise<BrowserConnection> {
  console.log('[BrowserManager] Connecting to Chrome via debug port 9222...');
  
  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9222',
    defaultViewport: null
  });
  
  const pages = await browser.pages();
  let page: Page;
  
  if (pages.length === 0) {
    page = await browser.newPage();
    console.log('[BrowserManager] No pages found, created new page');
  } else {
    page = pages[0];
    console.log('[BrowserManager] Using existing page');
  }
  
  return {
    browser,
    page,
    type: 'chrome_debug'
  };
}

/**
 * Connect to a browser using Incogniton profile
 * Uses Incogniton's Automation API for Puppeteer integration
 */
async function connectIncogniton(profileId: string): Promise<BrowserConnection> {
  console.log(`[BrowserManager] Launching Incogniton profile: ${profileId}...`);
  
  // Use explicit IPv4 address instead of localhost to avoid IPv6 resolution issues
  const INCOGNITON_API = 'http://127.0.0.1:35000';
  const FETCH_TIMEOUT = 30000; // 30 seconds
  
  // Helper function to fetch with timeout
  const fetchWithTimeout = async (url: string, options: RequestInit = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  };
  
  try {
    // First, try to stop any existing profile instance
    console.log('[BrowserManager] Ensuring profile is stopped before launch...');
    try {
      await fetchWithTimeout(`${INCOGNITON_API}/profile/stop/${profileId}`, {
        method: 'GET'
      });
      console.log('[BrowserManager] Stopped any existing profile instance');
      // Wait a moment for profile to fully stop
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      // Profile might not be running, that's ok
      console.log('[BrowserManager] No existing profile to stop (or already stopped)');
    }
    
    // Use Incogniton's Automation API to launch profile with Puppeteer
    // Endpoint: GET /automation/launch/puppeteer/{profile_id}
    // Returns: { puppeteerUrl: "http://127.0.0.1:PORT", status: "ok" }
    let launchResponse = await fetchWithTimeout(`${INCOGNITON_API}/automation/launch/puppeteer/${profileId}`, {
      method: 'GET'
    });
    
    let launchData = await launchResponse.json();
    console.log(`[BrowserManager] Profile launch response:`, launchData);
    
    // Check if response indicates an error (Incogniton returns 200 OK with status: 'error')
    if (!launchResponse.ok || launchData.status === 'error') {
      // If profile is out of sync, try to force sync with local backup
      if (launchData.message?.includes('out of sync')) {
        console.log('[BrowserManager] Profile out of sync, attempting to sync...');
        
        // Step 1: Force sync with local backup (this launches in normal mode)
        const syncResponse = await fetchWithTimeout(`${INCOGNITON_API}/profile/launch/${profileId}/force/local`, {
          method: 'GET'
        });
        
        const syncData = await syncResponse.json();
        console.log('[BrowserManager] Sync response:', syncData);
        
        if (!syncResponse.ok || syncData.status !== 'ok') {
          throw new Error(`Failed to sync profile: ${JSON.stringify(syncData)}`);
        }
        
        console.log('[BrowserManager] Profile synced successfully');
        
        // Step 2: Stop the profile (it's running in normal mode after sync)
        console.log('[BrowserManager] Stopping profile to relaunch in automation mode...');
        const stopResponse = await fetchWithTimeout(`${INCOGNITON_API}/profile/stop/${profileId}`, {
          method: 'GET'
        });
        
        const stopData = await stopResponse.json();
        console.log('[BrowserManager] Stop response:', stopData);
        
        // Wait for profile to fully stop
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Step 3: Retry the Puppeteer launch (now in automation mode)
        console.log('[BrowserManager] Retrying Puppeteer launch...');
        launchResponse = await fetchWithTimeout(`${INCOGNITON_API}/automation/launch/puppeteer/${profileId}`, {
          method: 'GET'
        });
        
        launchData = await launchResponse.json();
        console.log(`[BrowserManager] Retry response:`, launchData);
      }
      
      // Check again after potential retry
      if (!launchResponse.ok || launchData.status === 'error') {
        throw new Error(`Failed to launch Incogniton profile: ${launchData.message || 'Unknown error'}`);
      }
    }
    
    if (!launchData.puppeteerUrl) {
      throw new Error(`No puppeteerUrl in response: ${JSON.stringify(launchData)}`);
    }
    
    // Use the HTTP URL directly - Puppeteer will query it to get the WebSocket endpoint
    const browserURL = launchData.puppeteerUrl;
    
    console.log(`[BrowserManager] Connecting Puppeteer to ${browserURL}...`);
    
    // Browser needs time to fully start - retry connection with delays
    let browser;
    let lastError;
    const maxRetries = 5;
    const retryDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[BrowserManager] Connection attempt ${attempt}/${maxRetries}...`);
        browser = await puppeteer.connect({
          browserURL,
          defaultViewport: null
        });
        console.log(`[BrowserManager] Puppeteer connected to Incogniton profile ${profileId}`);
        break; // Success!
      } catch (error) {
        lastError = error;
        console.log(`[BrowserManager] Connection attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        
        if (attempt < maxRetries) {
          console.log(`[BrowserManager] Waiting ${retryDelay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    if (!browser) {
      throw new Error(`Failed to connect after ${maxRetries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    
    // Get or create a page
    const pages = await browser.pages();
    let page: Page;
    
    if (pages.length === 0) {
      page = await browser.newPage();
      console.log('[BrowserManager] Created new page in Incogniton browser');
    } else {
      // Close all extra pages except the first one to avoid multiple windows
      if (pages.length > 1) {
        console.log(`[BrowserManager] Closing ${pages.length - 1} extra tabs...`);
        for (let i = 1; i < pages.length; i++) {
          await pages[i].close();
        }
      }
      page = pages[0];
      console.log('[BrowserManager] Using existing page from Incogniton browser');
    }
    
    // Note: To set browser window width, configure it in the Incogniton profile settings:
    // 1. Open Incogniton app
    // 2. Edit your profile
    // 3. Advanced Settings > Screen Resolution
    // 4. Set width to 800px
    
    return {
      browser,
      page,
      type: 'incogniton',
      profileId
    };
  } catch (error) {
    console.error(`[BrowserManager] Error connecting to Incogniton:`, error);
    throw new Error(`Failed to connect to Incogniton profile: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Connect to browser for a specific TikTok account
 * Automatically chooses the right connection method based on account settings
 */
export async function connectBrowserForAccount(account: TikTokAccount): Promise<BrowserConnection> {
  console.log(`[BrowserManager] Connecting browser for account ${account.account_id}...`);
  console.log(`[BrowserManager] Browser type: ${account.browser_type}`);
  
  if (account.browser_type === 'incogniton' && account.incogniton_profile_id) {
    return await connectIncogniton(account.incogniton_profile_id);
  } else {
    // Fallback to Chrome Debug mode (legacy)
    console.log('[BrowserManager] Using legacy Chrome Debug mode');
    return await connectChromeDebug();
  }
}

/**
 * Close browser connection and cleanup resources
 */
export async function closeBrowserConnection(connection: BrowserConnection): Promise<void> {
  console.log(`[BrowserManager] Closing ${connection.type} browser connection...`);
  
  try {
    if (connection.type === 'incogniton' && connection.profileId) {
      // Disconnect Puppeteer (but keep profile running)
      await connection.browser.disconnect();
      console.log('[BrowserManager] Disconnected from Incogniton profile');
      
      // Optional: Stop the profile if you want to fully close it
      // Uses Incogniton API endpoint: GET /profile/stop/{profile_id}
      const INCOGNITON_API = 'http://127.0.0.1:35000';
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 sec timeout
        
        const stopResponse = await fetch(`${INCOGNITON_API}/profile/stop/${connection.profileId}`, {
          method: 'GET',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (stopResponse.ok) {
          const stopData = await stopResponse.json();
          console.log(`[BrowserManager] Incogniton profile ${connection.profileId} stopped:`, stopData);
        } else {
          console.warn(`[BrowserManager] Failed to stop profile, but continuing...`);
        }
      } catch (stopError) {
        console.warn(`[BrowserManager] Error stopping profile (non-critical):`, stopError);
      }
    } else {
      // Chrome Debug mode - just disconnect (don't close the actual Chrome instance)
      await connection.browser.disconnect();
      console.log('[BrowserManager] Disconnected from Chrome Debug port');
    }
  } catch (error) {
    console.error('[BrowserManager] Error closing browser:', error);
    throw error;
  }
}

/**
 * Switch to a different account's browser
 * Closes current connection and opens new one
 */
export async function switchToAccount(
  currentConnection: BrowserConnection | null,
  newAccount: TikTokAccount
): Promise<BrowserConnection> {
  console.log(`[BrowserManager] Switching to account ${newAccount.account_id}...`);
  
  // Close current connection if exists
  if (currentConnection) {
    await closeBrowserConnection(currentConnection);
    console.log('[BrowserManager] Previous connection closed');
  }
  
  // Connect to new account's browser
  const newConnection = await connectBrowserForAccount(newAccount);
  console.log(`[BrowserManager] ✅ Successfully switched to account ${newAccount.account_id}`);
  
  return newConnection;
}
