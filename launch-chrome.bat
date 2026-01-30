@echo off
REM ====================================================================
REM SocialCanvasser - Chrome Debug Mode Launcher
REM ====================================================================
REM 
REM This script launches Chrome with remote debugging enabled.
REM This allows the SocialCanvasser app to automate your browser.
REM
REM IMPORTANT: Close ALL Chrome windows before running this!
REM ====================================================================

echo.
echo ========================================
echo  SocialCanvasser Chrome Launcher
echo ========================================
echo.
echo IMPORTANT: Make sure ALL Chrome windows are closed!
echo.
pause

REM Kill any existing Chrome processes
taskkill /F /IM chrome.exe 2>nul

REM Wait a moment for processes to close
timeout /t 2 /nobreak >nul

REM Create profile directory if it doesn't exist
set PROFILE_DIR=%USERPROFILE%\SocialCanvasserProfiles\Chrome
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo.
echo Starting Chrome in debug mode...
echo Profile: %PROFILE_DIR%
echo Debug Port: 9222
echo.

REM Launch Chrome with remote debugging
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
echo  Chrome is now running in debug mode!
echo ========================================
echo.
echo Next steps:
echo 1. Log into TikTok in the Chrome window that just opened
echo 2. Go back to SocialCanvasser and click "I'm Logged In"
echo 3. Leave Chrome window open while using the app
echo.
echo Chrome is running in the background. You can now close this window.
echo (Chrome will keep running even after you close this terminal)
echo.
