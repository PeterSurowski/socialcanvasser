# TikTok Login Workaround

## Problem
TikTok is blocking logins in the Docker container environment, showing "Maximum number of attempts reached" even for manual logins. This is likely due to:
- Fresh Chrome profile with no browsing history
- Linux environment fingerprinting
- Too many login attempts from same IP address
- Virtual display (Xvfb) detection

## Solution 1: Wait and Use VPN
1. **Wait 24-48 hours** before trying again (let TikTok's rate limit reset)
2. Use a VPN or different network
3. Only create ONE test account to avoid triggering rate limits

## Solution 2: Manual Login on Real Desktop Chrome (Recommended)
Instead of using the Docker container for login, log in with your real Windows Chrome browser, then transfer the session:

### Steps:
1. Open Chrome on your Windows desktop
2. Log into TikTok normally (with 2FA if needed)
3. Open DevTools (F12) → Application → Cookies
4. Copy all `tiktok.com` cookies
5. Store them in the database for your account
6. The scraper will use these cookies when connecting to the containerized Chrome

### Implementation:
We can add an endpoint `/api/onboarding/tiktok/manual-cookies` that accepts cookies from your desktop browser and stores them in `session_data`.

## Solution 3: Improve Docker Browser Fingerprint
Add these flags to make Chrome look more like a real Windows browser:
- Custom user agent (Windows)
- Pre-populated browser history
- Timezone/locale settings
- Canvas/WebGL fingerprint masking

Which approach would you like to try?
