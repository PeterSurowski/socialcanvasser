// ====================================================================
// TikTok Cookie Extraction Script V2 - USING CHROME DEVTOOLS
// ====================================================================
// 
// INSTRUCTIONS:
// 1. Open Chrome and log into TikTok normally (https://www.tiktok.com)
// 2. Open DevTools (F12 or right-click → Inspect)
// 3. Go to the "Application" tab (or "Storage" in some Chrome versions)
// 4. In the left sidebar: Expand "Cookies" → Click on "https://www.tiktok.com"
// 5. You should see a table with all cookies
// 6. Now go back to the "Console" tab
// 7. Paste this ENTIRE script and press Enter
// 8. Copy the cookies that appear between START and END markers
//
// ====================================================================

(async function extractTikTokCookiesV2() {
  try {
    console.log('🔍 Extracting TikTok cookies using DevTools Protocol...');
    
    // Try to get cookies using chrome.cookies API (if available)
    // This won't work in regular browser context, so we'll use a different approach
    
    // Method 1: Try to read from Chrome's internal cookie store
    let cookies = [];
    
    // Check if we're in a context where we can access cookies
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      console.log('📦 Using Chrome extension API...');
      cookies = await new Promise((resolve) => {
        chrome.cookies.getAll({ domain: '.tiktok.com' }, (results) => {
          resolve(results);
        });
      });
    } else {
      // Fallback: Use document.cookie but warn user
      console.log('⚠️ Cannot access HttpOnly cookies from this context');
      console.log('⚠️ Using document.cookie (may be incomplete)');
      console.log('');
      console.log('🔧 RECOMMENDED METHOD:');
      console.log('1. Open Chrome DevTools → Application tab');
      console.log('2. Expand "Cookies" → Click "https://www.tiktok.com"');
      console.log('3. Right-click on the cookie table → "Copy all as JSON" (if available)');
      console.log('   OR manually copy these important cookies:');
      console.log('   - sessionid');
      console.log('   - sessionid_ss');
      console.log('   - sid_tt');
      console.log('   - sid_guard');
      console.log('   - uid_tt');
      console.log('   - uid_tt_ss');
      console.log('');
      
      const cookieString = document.cookie;
      
      if (!cookieString) {
        console.error('❌ No cookies found. Make sure you are logged into TikTok.');
        return;
      }
      
      cookies = cookieString.split(';').map(c => {
        const trimmed = c.trim();
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex === -1) return null;
        
        const name = trimmed.substring(0, equalsIndex);
        const value = trimmed.substring(equalsIndex + 1);
        
        return {
          name: name,
          value: value,
          domain: '.tiktok.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax'
        };
      }).filter(c => c !== null);
    }
    
    if (cookies.length === 0) {
      console.error('❌ No valid cookies found.');
      return;
    }
    
    // Convert to Puppeteer format
    const puppeteerCookies = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.tiktok.com',
      path: c.path || '/',
      expires: c.expirationDate || c.expires || -1,
      httpOnly: c.httpOnly || false,
      secure: c.secure !== false, // Default to true
      sameSite: c.sameSite || 'Lax'
    }));
    
    const cookiesJson = JSON.stringify(puppeteerCookies, null, 2);
    
    console.log('✅ SUCCESS! Cookies extracted!');
    console.log(`📊 Total cookies extracted: ${puppeteerCookies.length}`);
    console.log('');
    
    // Check for important auth cookies
    const authCookies = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss'];
    const foundAuthCookies = authCookies.filter(name => 
      puppeteerCookies.some(c => c.name === name)
    );
    
    if (foundAuthCookies.length > 0) {
      console.log(`✅ Found auth cookies: ${foundAuthCookies.join(', ')}`);
    } else {
      console.warn('⚠️ WARNING: No authentication cookies found!');
      console.warn('⚠️ This may not work. Try the manual method below.');
    }
    
    console.log('');
    console.log('COPY EVERYTHING BETWEEN THE LINES BELOW:');
    console.log('==================== START ====================');
    console.log(cookiesJson);
    console.log('===================== END =====================');
    console.log('');
    console.log('Next steps:');
    console.log('1. SELECT and COPY all the JSON above (between START and END)');
    console.log('2. Go to SocialCanvasser onboarding');
    console.log('3. Add TikTok Account → Choose "Import cookies"');
    console.log('4. PASTE the cookies into the textarea');
    console.log('5. Click "Import Cookies"');
    
  } catch (error) {
    console.error('❌ Error extracting cookies:', error);
    console.log('');
    console.log('📝 MANUAL METHOD:');
    console.log('1. DevTools → Application → Cookies → https://www.tiktok.com');
    console.log('2. Look for these cookies and copy their values:');
    console.log('   - sessionid');
    console.log('   - sessionid_ss');  
    console.log('   - sid_tt');
    console.log('3. Create a JSON array manually with the format shown above');
  }
})();
