@echo off
setlocal

for %%I in ("%cd%") do set PROJECT_NAME=%%~nxI

set VPS=root@168.144.83.115
set REMOTE_PATH=/root/workspaces/%PROJECT_NAME%
set ARCHIVE=%TEMP%%PROJECT_NAME%.tar.gz

echo.
echo =========================================
echo Pushing: %PROJECT_NAME%
echo =========================================
echo.

echo [1/4] Creating archive...

tar ^
--exclude=node_modules ^
--exclude=.next ^
--exclude=dist ^
--exclude=build ^
--exclude=coverage ^
--exclude=**pycache** ^
-czf "%ARCHIVE%" .

if errorlevel 1 (
echo Failed to create archive.
pause
exit /b 1
)

echo.
echo [2/4] Uploading archive...

scp "%ARCHIVE%" %VPS%:/tmp/%PROJECT_NAME%.tar.gz

if errorlevel 1 (
echo Upload failed.
del "%ARCHIVE%" >nul 2>&1
pause
exit /b 1
)

echo.
echo [3/4] Extracting on VPS...

ssh %VPS% "mkdir -p %REMOTE_PATH% && tar -xzf /tmp/%PROJECT_NAME%.tar.gz -C %REMOTE_PATH% && rm -f /tmp/%PROJECT_NAME%.tar.gz"

if errorlevel 1 (
echo Remote extraction failed.
del "%ARCHIVE%" >nul 2>&1
pause
exit /b 1
)

echo.
echo [4/4] Cleaning up...

del "%ARCHIVE%" >nul 2>&1

echo.
echo =========================================
echo Push complete!
echo Workspace: %PROJECT_NAME%
echo Path: %REMOTE_PATH%
echo =========================================
pause
