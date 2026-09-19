@echo off
title Aaryan Aqua Needs - Building Windows Desktop App
color 0b
echo ========================================================
echo   Aaryan Aqua Needs - Building Windows Desktop App
echo ========================================================
echo.

echo [1/3] Checking Node.js environment...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    pause
    exit /b 1
)

echo [2/3] Building Windows Installer (.exe) and Portable App (.exe)...
call npm run build:win

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo   [SUCCESS] Windows Desktop App built successfully!
    echo   Check the 'dist' folder for your executables:
    echo     - Setup Installer: dist\Aaryan Aqua Needs Setup 5.3.0.exe
    echo     - Portable App:   dist\Aaryan Aqua Needs Portable 5.3.0.exe
    echo ========================================================
    echo.
    explorer dist
) else (
    echo.
    echo [ERROR] Build failed! Check the error log above.
    echo.
)

pause
