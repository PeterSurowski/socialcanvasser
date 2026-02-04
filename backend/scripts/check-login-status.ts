/**
 * Script to check which TikTok account is currently logged in to Chrome
 */

import puppeteer from 'puppeteer-core';

async function main() {
  try {
    console.log('🔍 Connecting to Chrome...');
    
    const browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222'
    });

    const pages = await browser.pages();
    const tiktokPage = pages.find(p => p.url().includes('tiktok.com'));
    
    if (!tiktokPage) {
      console.log('❌ No TikTok page found. Please open TikTok in Chrome first.');
      await browser.disconnect();
      return;
    }

    console.log(`✅ Found TikTok page: ${tiktokPage.url()}`);
    
    // Navigate to profile to check username
    await tiktokPage.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check if logged in and get username
    const userInfo = await tiktokPage.evaluate(() => {
      // Try to find profile link or username in navbar
      const profileLink = document.querySelector('a[href*="/@"]');
      if (profileLink) {
        const href = profileLink.getAttribute('href') || '';
        const match = href.match(/\/@([^/?]+)/);
        return {
          loggedIn: true,
          username: match ? match[1] : 'unknown'
        };
      }
      
      // Check for login button
      const loginButton = document.querySelector('[data-e2e="top-login-button"]');
      if (loginButton) {
        return { loggedIn: false, username: null };
      }
      
      return { loggedIn: 'unknown', username: null };
    });
    
    console.log('\n📊 Current Login Status:');
    if (userInfo.loggedIn === true) {
      console.log(`✅ Logged in as: @${userInfo.username}`);
    } else if (userInfo.loggedIn === false) {
      console.log('❌ Not logged in');
    } else {
      console.log('⚠️ Could not determine login status');
    }
    
    await browser.disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

main();
