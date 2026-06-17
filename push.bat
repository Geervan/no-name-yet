@echo off

for %%I in ("%cd%") do set PROJECT_NAME=%%~nxI

echo.
echo Uploading %PROJECT_NAME%...
echo.

for /f "delims=" %%i in ('wsl wslpath "%cd%"') do set WSLPATH=%%i

wsl /mnt/d/Portable\ development/push.sh "%WSLPATH%"

echo.
echo Finished.
pause