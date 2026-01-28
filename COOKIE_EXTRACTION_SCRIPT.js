// ====================================================================
// TikTok Cookie Extraction Script
// ====================================================================
// 
// INSTRUCTIONS:
// 1. Open Chrome and log into TikTok normally (https://www.tiktok.com)
// 2. Open DevTools (F12 or right-click → Inspect)
// 3. Go to the "Console" tab
// 4. Paste this ENTIRE script and press Enter
// 5. The cookies will be logged below - copy them manually
// 6. Go to SocialCanvasser onboarding, select "Import cookies"
// 7. Paste the copied cookies into the textarea
//
// ====================================================================

(function extractTikTokCookies() {
  try {
    // Get cookies from document.cookie (works everywhere)
    const cookieString = document.cookie;
    
    if (!cookieString) {
      console.error('❌ No cookies found. Make sure you are logged into TikTok.');
      return;
    }
    
    // Parse cookies
    const cookies = cookieString.split(';').map(c => {
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
    
    if (cookies.length === 0) {
      console.error('❌ No valid cookies found.');
      return;
    }
    
    // Convert to JSON string
    const cookiesJson = JSON.stringify(cookies, null, 2);
    
    console.log('✅ SUCCESS! Cookies extracted!');
    console.log(`📊 Total cookies extracted: ${cookies.length}`);
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
  }
})();
