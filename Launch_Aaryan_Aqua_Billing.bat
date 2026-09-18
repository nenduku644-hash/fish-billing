@echo off
title Aaryan Aqua Needs - Billing & WhatsApp Automation
cd /d "%~dp0"

echo ========================================================
echo   AARYAN AQUA NEEDS - COMMERCIAL GST BILLING
echo   1-Click Software & WhatsApp Automation Launcher
echo ========================================================
echo.

:: 1. Check if WhatsApp Bot daemon is already active on port 3001
netstat -aon | findstr :3001 | findstr LISTENING >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/2] Starting WhatsApp Bot Companion on port 3001...
    start /min "Aaryan Aqua WhatsApp Bot" cmd /c "set NO_AUTO_OPEN=true&& set DAEMON=true&& node whatsapp-bot.js"
    timeout /t 3 /nobreak >nul
) else (
    echo [1/2] WhatsApp Bot Companion is already running on port 3001.
)

:: 2. Launch App in dedicated desktop mode
echo [2/2] Launching Billing Dashboard...
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:3001
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --app=http://localhost:3001
) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3001
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3001
) else (
    start http://localhost:3001
)

echo.
echo ========================================================
echo   Application launched successfully!
echo   WhatsApp Invoices will dispatch silently in background.
echo ========================================================
timeout /t 3 /nobreak >nul
exit
