@echo off
setlocal EnableDelayedExpansion
title VencordCustom Installer
echo === Installing VencordCustom ===
echo.

set "TARGET=%APPDATA%\VencordCustom"

call :detect
if "!COUNT!"=="0" (
    echo No Discord installation found.
    goto :fail
)
call :choose "install into" || goto :fail

echo.
echo Discord will be closed briefly.
call :killall

if exist "%TARGET%\dist" rmdir /s /q "%TARGET%\dist"
mkdir "%TARGET%\dist" >nul 2>&1
xcopy /y /q "%~dp0dist\*" "%TARGET%\dist\" >nul || goto :fail

echo Downloading Vencord Installer...
curl -sL -o "%TARGET%\VencordInstallerCli.exe" https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe || goto :fail

set "VENCORD_USER_DATA_DIR=%TARGET%"
set "VENCORD_DEV_INSTALL=1"
for %%B in (!SELECTED!) do (
    echo.
    echo --- Installing into Discord %%B ---
    "%TARGET%\VencordInstallerCli.exe" -install -branch %%B || goto :fail
)

echo.
echo Done! Start Discord again.
pause
exit /b 0

:fail
echo.
echo Something went wrong, see the messages above.
pause
exit /b 1

rem ---------------------------------------------------------------------------
rem Finds installed Discord branches -> B1..Bn, N1..Nn, COUNT
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

rem Shows a menu and sets SELECTED to a space separated list of branches
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
