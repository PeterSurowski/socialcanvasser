# Incogniton Integration - Onboarding Guide

## Overview
Incogniton provides persistent browser profiles that maintain TikTok login sessions between automation runs. This enables automatic account switching without manual re-login.

**Integration Status**: The system now uses Incogniton's official Automation API (GET /automation/launch/puppeteer/{profile_id}) for reliable profile launching and browser control.

## Prerequisites

1. **Download and Install Incogniton**
   - Visit: https://incogniton.com/download
   - Install the desktop app (Windows/macOS)
   - Create a free account at: https://incogniton.com/pricing/
   - Launch the Incogniton desktop app and log in

2. **Keep Incogniton Running**
   - The desktop app MUST be running for the automation to work
   - The SDK communicates with the local app via http://localhost:35000

## Onboarding Flow for Each TikTok Account

### Step 1: Create Incogniton Profile
1. Open Incogniton desktop app
2. Click "New Profile"
3. Give it a meaningful name (e.g., "TikTok Account 1")
4. Configure optional settings:
   - Proxy (recommended for multiple accounts)
   - Browser fingerprint customization
   - Timezone/language settings
5. Click "Create Profile"
6. **Copy the Profile ID** from the profile details

### Step 2: First-Time Login to TikTok
1. In Incogniton, click "Start" on your new profile
2. A Chrome browser will open with the profile
3. Navigate to https://www.tiktok.com
4. Log in to your TikTok account
5. **IMPORTANT**: Complete any 2FA, captchas, or verification steps
6. Verify you're logged in successfully
7. **Leave the browser open** or close it - the session is saved in the profile

### Step 3: Add Account to SocialCanvasser

**⚠️ IMPORTANT: The UI doesn't support Incogniton yet!**

The onboarding UI currently only supports Chrome Debug mode. To use Incogniton profiles, you must add accounts via the database directly:

**Method: Database Direct (ONLY option currently)**

1. First, add the account through normal onboarding (using Chrome Debug mode):
   - Go to `/onboarding` 
   - Click "+ Add TikTok Account"
   - Follow the setup (even though you'll be using Incogniton)
   - Complete the onboarding
   - Note the Account ID (check database or logs)

2. Then update the account to use Incogniton:
```sql
-- Connect to database
mysql -u root -proot socialcanvasser

-- View your accounts and get the ID
SELECT id, account_identifier, browser_type FROM tiktok_accounts;

-- Update to use Incogniton (replace <PROFILE_ID> and <ACCOUNT_ID>)
UPDATE tiktok_accounts 
SET browser_type = 'incogniton',
    incogniton_profile_id = '<YOUR_INCOGNITON_PROFILE_ID>'
WHERE id = <ACCOUNT_ID>;

-- Verify the change
SELECT id, account_identifier, browser_type, incogniton_profile_id FROM tiktok_accounts;
```

3. Restart the backend server:
```bash
# Stop backend (Ctrl+C)
# Then restart
cd backend
npm run dev
```

**Future Enhancement**: A UI for adding/editing Incogniton profiles will be added to Settings page.

### Step 4: Test Automation
1. Go to Dashboard
2. Click "Start Automation"
3. Watch terminal logs to confirm:
   ```
   [BrowserManager] Launching Incogniton profile: <your-profile-id>...
   [BrowserManager] Puppeteer connected to Incogniton profile
   ```

## Account Rotation Behavior

### Automatic Switching
When account action limit is reached:
1. Current Incogniton profile is closed
2. Next account's profile is launched automatically
3. TikTok session is already logged in (from onboarding)
4. Automation continues seamlessly

### What Users See
```
⚠️ Action limit reached (10 actions). Switching to next account...
✅ Switched to account @tiktok_account_2
```

## Troubleshooting

### "Incogniton desktop app not running"
- Solution: Launch the Incogniton desktop app
- Verify it's running at http://localhost:35000

### "Profile not found"
- Solution: Verify the Profile ID is correct
- Open Incogniton app → Profile Settings → Copy Profile ID

### "Profile login required"
- Solution: Open profile in Incogniton, login to TikTok manually
- The session will be saved automatically

### "Port 35000 already in use"
- Solution: Check if another instance of Incogniton is running
- Restart the Incogniton desktop app

## Pricing Considerations

**Free Plan**: 
- 10 profiles
- Good for testing or small-scale use

**Starter Plan** ($29.99/month):
- 50 profiles
- API access included
- Suitable for most users

**Professional Plans**:
- 100-500+ profiles
- Team collaboration
- Priority support

## Migration from Chrome Debug Mode

### For Each Existing Account:
1. Create Incogniton profile (see Step 1 above)
2. Login to TikTok in that profile (see Step 2 above)
3. Update account in SocialCanvasser:
   - Change browser_type to 'incogniton'
   - Add incogniton_profile_id
4. Test automation

### Gradual Migration Strategy:
- Migrate accounts one at a time
- Test each migration before proceeding
- Keep Chrome Debug accounts as backup during transition
- Once all accounts migrated, retire Chrome Debug mode

## Database Schema

```sql
-- Already applied via migration
ALTER TABLE tiktok_accounts 
ADD COLUMN incogniton_profile_id VARCHAR(255) DEFAULT NULL,
ADD COLUMN browser_type ENUM('chrome_debug', 'incogniton') DEFAULT 'chrome_debug';
```

## Support

If you encounter issues:
1. Check Incogniton docs: https://api-docs.incogniton.com/
2. Join Incogniton Telegram: https://t.me/incognitonOfficial
3. Check SocialCanvasser logs for detailed error messages
