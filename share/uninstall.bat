@echo off
setlocal EnableDelayedExpansion
title Uninstall VencordCustom
echo === Uninstalling VencordCustom ===
echo.

set "TARGET=%APPDATA%\VencordCustom"

call :detect
if "!COUNT!"=="0" (
    echo No Discord installation found.
    pause
    exit /b 1
)
call :choose "uninstall from"

call :killall

if not exist "%TARGET%\VencordInstallerCli.exe" (
    mkdir "%TARGET%" >nul 2>&1
    curl -sL -o "%TARGET%\VencordInstallerCli.exe" https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe
)
for %%B in (!SELECTED!) do (
    echo.
    echo --- Uninstalling from Discord %%B ---
    "%TARGET%\VencordInstallerCli.exe" -uninstall -branch %%B
)

echo.
echo Uninstalled. Discord is back to normal.
pause
exit /b 0

rem ---------------------------------------------------------------------------
:detect
set COUNT=0
for %%E in ("Discord:stable:Discord (Stable)" "DiscordPTB:ptb:Discord PTB" "DiscordCanary:canary:Discord Canary") do (
    for /f "tokens=1-3 delims=:" %%a in (%%E) do (
        if exist "%LOCALAPPDATA%\%%a\Update.exe" (
            set /a COUNT+=1
            set "B!COUNT!=%%b"
            set "N!COUNT!=%%c"
        )
    )
)
exit /b 0

:choose
if "!COUNT!"=="1" (
    set "SELECTED=!B1!"
    echo Found: !N1!
    exit /b 0
)
echo Which Discord do you want to %~1?
echo.
for /l %%i in (1,1,!COUNT!) do echo   [%%i] !N%%i!
echo   [A] All of them
echo.
:ask
set "PICK="
set /p "PICK=Your choice: "
if /i "!PICK!"=="A" (
    set "SELECTED="
    for /l %%i in (1,1,!COUNT!) do set "SELECTED=!SELECTED! !B%%i!"
    exit /b 0
)
for /l %%i in (1,1,!COUNT!) do if "!PICK!"=="%%i" (
    set "SELECTED=!B%%i!"
    exit /b 0
)
echo Invalid choice, try again.
goto :ask

:killall
taskkill /f /im Discord.exe >nul 2>&1
taskkill /f /im DiscordPTB.exe >nul 2>&1
taskkill /f /im DiscordCanary.exe >nul 2>&1
exit /b 0
