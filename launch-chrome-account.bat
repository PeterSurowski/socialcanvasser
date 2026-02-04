@echo off
REM ====================================================================
REM SocialCanvasser - Chrome Debug Mode Launcher for Specific Account
REM ====================================================================
REM 
REM This script launches Chrome with remote debugging for a specific account.
REM Each account gets its own profile directory to maintain separate sessions.
REM
REM Usage: launch-chrome-account.bat <account_id>
REM Example: launch-chrome-account.bat 130
REM ====================================================================

IF "%1"=="" (
    echo ERROR: Account ID required!
    echo Usage: launch-chrome-account.bat ^<account_id^>
    echo Example: launch-chrome-account.bat 130
    pause
    exit /b 1
)

set ACCOUNT_ID=%1

echo.
echo ========================================
echo  SocialCanvasser Chrome Launcher
echo  Account ID: %ACCOUNT_ID%
echo ========================================
echo.
echo IMPORTANT: Make sure ALL Chrome windows are closed!
echo.
pause

REM Kill any existing Chrome processes
taskkill /F /IM chrome.exe 2>nul

REM Wait a moment for processes to close
timeout /t 2 /nobreak >nul

REM Create profile directory for this specific account
set PROFILE_DIR=%USERPROFILE%\SocialCanvasserProfiles\Account_%ACCOUNT_ID%
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo.
echo Starting Chrome in debug mode...
echo Profile: %PROFILE_DIR%
echo Debug Port: 9222
echo Account: %ACCOUNT_ID%
echo.

REM Launch Chrome with remote debugging and account-specific profile
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE_DIR%" ^
  --disable-features=IsolateOrigins,site-per-process ^
  --disable-site-isolation-trials ^
  --disable-web-security ^
  --disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure ^
  https://www.tiktok.com

echo.
echo ========================================
echo  Chrome is now running for Account %ACCOUNT_ID%!
echo ========================================
echo.
echo Next steps:
echo 1. Log into TikTok with your account %ACCOUNT_ID% in the Chrome window
echo 2. Go back to SocialCanvasser and click "I'm Logged In"
echo 3. Leave Chrome window open while using the app
echo.
echo Chrome is running in the background. You can now close this window.
echo (Chrome will keep running even after you close this terminal)
echo.
