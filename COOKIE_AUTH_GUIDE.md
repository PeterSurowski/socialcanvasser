# Cookie-Based Authentication Guide

## ✅ Implementation Complete!

The cookie import system is now fully implemented and ready to use!

## 🚀 How to Use

### Step 1: Extract Cookies from Your Desktop Chrome

1. Open **Chrome** on your Windows desktop
2. Navigate to **https://www.tiktok.com** and **log in normally**
3. Open **DevTools** (F12 or Right-click → Inspect)
4. Go to the **Console** tab
5. Open the file: `COOKIE_EXTRACTION_SCRIPT.js`
6. Copy the **entire script** 
7. Paste into the **Console** and press **Enter**
8. ✅ Cookies are automatically **copied to clipboard**!

### Step 2: Import Cookies into SocialCanvasser

1. Start your backend: `cd backend && npm run dev`
2. Start your frontend: `cd frontend && npm run dev`
3. Go to **Onboarding** → **Add TikTok Account**
4. Select **"Import cookies"** (default selection)
5. Give the account a nickname (e.g., "Main Account")
6. **Paste** the cookies into the textarea (Ctrl+V)
7. Click **"Import Cookies"**
8. ✅ Done! Account is ready to scrape

### Step 3: Test the Scraper

1. Make sure you have keywords configured
2. Go to **Dashboard**
3. Click **"Start"** button
4. Check backend logs for `[TikTok Search]` messages
5. Query database to see results:
   ```bash
   mysql -u root -proot socialcanvasser -e "SELECT * FROM tiktok_posts LIMIT 10;"
   ```

## 🔧 How It Works

1. **Authentication**: You log in on your real Windows Chrome (TikTok trusts it)
2. **Cookie Export**: Script extracts session cookies in Puppeteer format
3. **Storage**: Backend stores cookies in `session_data` JSON field
4. **Injection**: Search worker injects cookies into Docker Chrome before scraping
5. **Scraping**: Puppeteer navigates TikTok as authenticated user, scrapes posts

## 📝 Technical Details

- **Backend Endpoint**: `/api/onboarding/tiktok/import-cookies`
- **Cookie Format**: Puppeteer `Protocol.Network.Cookie[]` array
- **Storage**: `tiktok_accounts.session_data` JSON with `type: 'cookies'`
- **Worker**: Modified to detect cookie-based auth and inject before navigating

## ⚠️ Important Notes

- Cookies **expire** after a few days/weeks (TikTok session timeout)
- When cookies expire, just re-import fresh cookies from desktop Chrome
- The Docker container is still created (for debugPort) but login happens via cookies
- No more TikTok bot detection since actual login happens on real Chrome!

## 🐛 Troubleshooting

**Script doesn't work in Console?**
- Try the alternative manual method in the script comments
- Or manually copy cookies from DevTools → Application → Cookies

**Cookies not working in scraper?**
- Check they were imported: `SELECT session_data FROM tiktok_accounts WHERE id = X;`
- Verify cookies are still valid by visiting TikTok in desktop Chrome
- Re-import fresh cookies if session expired

**Search worker errors?**
- Check backend logs for detailed error messages
- Verify account is marked as active: `is_active = 1`
- Make sure only ONE account is active at a time

## 🎉 Benefits

✅ **No more TikTok blocking** - login happens on trusted desktop Chrome  
✅ **Fast development** - no waiting 24 hours between tests  
✅ **Easy to refresh** - just re-run script when cookies expire  
✅ **Fully automated scraping** - Puppeteer has full access with valid session  
✅ **Multiple accounts** - import cookies for as many accounts as you need  

## Next Steps

Once scraping works, you can add:
- Automated DM/comment actions
- AI-powered response generation
- Rate limiting and cooldowns
- Multiple account rotation
