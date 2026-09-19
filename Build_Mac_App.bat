@echo off
title Aaryan Aqua Needs - Building MacBook Desktop App
color 0b
echo ========================================================
echo   Aaryan Aqua Needs - Building MacBook (macOS) App
echo ========================================================
echo.

echo [1/2] Packaging macOS application (.zip / .dmg)...
call npm run build:mac

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo   [SUCCESS] MacBook (macOS) App built successfully!
    echo   Check the 'dist' folder for your macOS packages.
    echo ========================================================
    echo.
    explorer dist
) else (
    echo.
    echo [NOTE] Note on macOS building on Windows:
    echo If macOS DMG creation encounters host platform restrictions,
    echo the GitHub Actions cloud release pipeline automatically compiles
    echo 100%% native DMGs on Apple macOS runners.
    echo.
)

pause
