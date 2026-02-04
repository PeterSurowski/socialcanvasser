/**
 * Test script to verify cookies work when injected into new browser context
 */

import puppeteer from 'puppeteer-core';
import db from '../src/config/database.js';

async function testCookiesForAccount(accountId: number) {
  try {
    console.log(`\n🧪 Testing cookies for account ${accountId}...`);
    
    // Get account and cookies from database
    const [rows] = await db.query(
      'SELECT account_identifier, session_data FROM tiktok_accounts WHERE id = ?',
      [accountId]
    );
    
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`❌ Account ${accountId} not found`);
      return;
    }
    
    const account = rows[0] as any;
    const sessionData = JSON.parse(account.session_data || '{}');
    
    if (!sessionData.cookies || !Array.isArray(sessionData.cookies)) {
      console.log(`❌ No cookies found for account ${accountId}`);
      return;
    }
    
    console.log(`✅ Found ${sessionData.cookies.length} cookies for @${account.account_identifier}`);
    
    // Connect to Chrome
    const browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222'
    });
    
    // Create a NEW isolated context (this simulates account rotation)
    console.log('🆕 Creating new isolated browser context...');
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    
    // Inject cookies
    console.log(`🍪 Injecting ${sessionData.cookies.length} cookies...`);
    await page.setCookie(...sessionData.cookies);
    
    // Navigate to TikTok
    console.log('🌐 Navigating to TikTok...');
    await page.goto('https://www.tiktok.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait longer for page to fully load and check cookies
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if logged in and get username
    const loginInfo = await page.evaluate(() => {
      // Try to find profile link
      const profileLink = document.querySelector('a[href*="/@"]');
      if (profileLink) {
        const href = profileLink.getAttribute('href') || '';
        const match = href.match(/\/@([^/?]+)/);
        return {
          loggedIn: true,
          username: match ? match[1] : 'unknown',
          url: window.location.href
        };
      }
      
      // Check for login button
      const loginButton = document.querySelector('[data-e2e="top-login-button"]');
      if (loginButton) {
        return { loggedIn: false, username: null, url: window.location.href };
      }
      
      return { loggedIn: 'unknown', username: null, url: window.location.href };
    });
    
    console.log('\n📊 Test Results:');
    console.log(`  Account ID: ${accountId} (@${account.account_identifier})`);
    console.log(`  Logged In: ${loginInfo.loggedIn}`);
    if (loginInfo.loggedIn === true) {
      console.log(`  ✅ TikTok Username: @${loginInfo.username}`);
    } else {
      console.log(`  ❌ Not logged in - cookies didn't work`);
    }
    console.log(`  Current URL: ${loginInfo.url}`);
    
    // Clean up
    await context.close();
    await browser.disconnect();
    
    return loginInfo;
  } catch (error) {
    console.error(`❌ Error testing account ${accountId}:`, error);
    return null;
  }
}

async function main() {
  console.log('🔬 Cookie Injection Test\n');
  console.log('This script tests if cookies work when injected into a new browser context.\n');
  
  const result130 = await testCookiesForAccount(130);
  const result131 = await testCookiesForAccount(131);
  
  console.log('\n' + '='.repeat(50));
  console.log('📋 SUMMARY');
  console.log('='.repeat(50));
  
  if (result130 && result131) {
    if (result130.loggedIn && result131.loggedIn) {
      if (result130.username === result131.username) {
        console.log(`\n❌ PROBLEM: Both accounts show the same TikTok user (@${result130.username})`);
        console.log('This means the cookies are from the same TikTok account!');
      } else {
        console.log(`\n✅ SUCCESS: Different accounts detected!`);
        console.log(`  Account 130: @${result130.username}`);
        console.log(`  Account 131: @${result131.username}`);
      }
    } else {
      console.log('\n⚠️ One or both accounts not logged in - cookies may not be valid');
    }
  }
  
  process.exit(0);
}

main();
