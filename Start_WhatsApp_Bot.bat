@echo off
title Aaryan Aqua Needs - WhatsApp Bot Companion
cd /d "%~dp0"
cls
echo ========================================================
echo   AARYAN AQUA NEEDS - WHATSAPP BOT COMPANION
echo ========================================================
echo.
echo Starting WhatsApp Engine on port 3001...
echo A browser window will open shortly with your QR code.
echo Freeing port 3001 if occupied...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

node whatsapp-bot.js
pause
