/**
 * Script to capture cookies from currently logged-in Chrome and update accounts in database
 * Run this after logging into TikTok to capture session cookies for account rotation
 */

import puppeteer from 'puppeteer-core';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function captureCookiesForAccount(userId: number, accountId: number) {
  try {
    console.log(`\n🔍 Capturing cookies for account ${accountId}...`);
    
    // Connect to Chrome debug port
    const browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222'
    });

    // Get all pages and find TikTok
    const pages = await browser.pages();
    const tiktokPage = pages.find(p => p.url().includes('tiktok.com'));
    
    if (!tiktokPage) {
      console.error('❌ No TikTok page found. Please open TikTok in Chrome first.');
      await browser.disconnect();
      return false;
    }

    // Capture cookies
    const cookies = await tiktokPage.cookies();
    console.log(`✅ Captured ${cookies.length} cookies from TikTok`);

    await browser.disconnect();

    // Update database
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'social_canvasser'
    });

    const sessionData = {
      type: 'local-chrome',
      ready: true,
      cookies: cookies
    };

    await connection.execute(
      'UPDATE tiktok_accounts SET session_data = ? WHERE id = ? AND user_id = ?',
      [JSON.stringify(sessionData), accountId, userId]
    );

    console.log(`✅ Updated database for account ${accountId}`);
    
    await connection.end();
    return true;
  } catch (error) {
    console.error('❌ Error capturing cookies:', error);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
Usage: node capture-cookies.ts <userId> <accountId>

Example: node capture-cookies.ts 25 130

Steps:
1. Make sure Chrome is running with launch-chrome.bat
2. Log into TikTok in the Chrome window
3. Run this script to capture cookies for the account
    `);
    process.exit(1);
  }

  const userId = parseInt(args[0]);
  const accountId = parseInt(args[1]);

  if (isNaN(userId) || isNaN(accountId)) {
    console.error('❌ userId and accountId must be numbers');
    process.exit(1);
  }

  console.log(`📝 Capturing cookies for user ${userId}, account ${accountId}`);
  console.log('Make sure:');
  console.log('  1. Chrome is running (launch-chrome.bat)');
  console.log('  2. You are logged into TikTok in Chrome');
  console.log('');

  const success = await captureCookiesForAccount(userId, accountId);
  
  if (success) {
    console.log('\n✅ All done! The account should now stay logged in during rotation.');
  } else {
    console.log('\n❌ Failed to capture cookies. Check the error messages above.');
    process.exit(1);
  }
}

main();
