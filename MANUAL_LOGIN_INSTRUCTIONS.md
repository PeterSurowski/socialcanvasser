# HOW TO FIX: Manual TikTok Login in Container

## The Problem
`document.cookie` in Chrome doesn't capture HttpOnly cookies (security feature).  
TikTok's authentication cookies ARE HttpOnly, so we can't extract them properly.  
Result: Puppeteer injects incomplete cookies → TikTok shows "Log in" prompt

## The Solution
Your containers (account 99 = port 9321, account 100 = port 9322) are ALREADY RUNNING!  
Just log into TikTok manually INSIDE each container, and the session persists forever.

## Steps:

### Account 99 (Port 9321):
1. Open noVNC: http://localhost:7099
2. You'll see the Chrome browser running inside the container
3. Navigate to https://www.tiktok.com
4. Log in manually (use your real TikTok credentials)
5. Once logged in, close the noVNC tab
6. The container stays running with your logged-in session!

### Account 100 (Port 9322):
1. Open noVNC: http://localhost:7100
2. Navigate to https://www.tiktok.com
3. Log in manually
4. Close noVNC tab

## Then Test:
1. Go to your dashboard
2. Click "Start"
3. The search worker will connect to the container and use your already-logged-in session
4. No cookie injection needed!

## Why This Works:
- The container uses `--user-data-dir=/data/chrome-profile`
- This directory is mapped to a Docker volume (persists across restarts)
- When you log in manually, Chrome saves the session to that directory
- When Puppeteer connects via debug port, it reuses that same profile
- Result: Already authenticated!

## Port Mappings:
| Account | noVNC Port | Debug Port |
|---------|-----------|------------|
| 99      | 7099      | 9321       |
| 100     | 7100      | 9322       |

## After Logging In:
The search worker code needs ONE small change - skip cookie injection for cookie-based accounts with containers:

```typescript
if (sessionData.type === 'cookies' && sessionData.cookies) {
  // NEW: Check if this is actually a container with cookies (hybrid approach)
  // If it has a debugPort, it's a container - skip cookie injection
  if (!sessionData.debugPort) {
    await page.setCookie(...sessionData.cookies);
  }
}
```

Or better: Just change the session_data type from "cookies" back to "container" since you're using containers!
