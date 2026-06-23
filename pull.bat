@echo off
setlocal

for %%I in ("%cd%") do set PROJECT_NAME=%%~nxI

set VPS=root@168.144.83.115
set REMOTE_PATH=/root/workspaces/%PROJECT_NAME%
set ARCHIVE=%TEMP%\pull_tmp_%PROJECT_NAME%.tar.gz

echo.
echo =========================================
echo Pulling: %PROJECT_NAME%
echo =========================================
echo.

echo [1/4] Archiving files on VPS...

ssh %VPS% "tar --exclude='node_modules' --exclude='*/node_modules' --exclude='*/node_modules/*' --exclude='.next' --exclude='*/.next' --exclude='*/.next/*' --exclude='dist' --exclude='*/dist' --exclude='*/dist/*' --exclude='build' --exclude='*/build' --exclude='*/build/*' --exclude='coverage' --exclude='*/coverage' --exclude='*/coverage/*' --exclude='.vscode' --exclude='*/.vscode' --exclude='*/.vscode/*' --exclude='.agents' --exclude='*/.agents' --exclude='*/.agents/*' --exclude='.gemini' --exclude='*/.gemini' --exclude='*/.gemini/*' --exclude='*.tar.gz' --exclude='*.zip' --exclude='*__pycache__*' --exclude='*.pyc' -czf /tmp/pull_%PROJECT_NAME%.tar.gz -C %REMOTE_PATH% ."

if errorlevel 1 (
  echo Failed to create archive on VPS.
  pause
  exit /b 1
)

echo.
echo [2/4] Downloading archive...

scp %VPS%:/tmp/pull_%PROJECT_NAME%.tar.gz "%ARCHIVE%"

if errorlevel 1 (
  echo Download failed.
  ssh %VPS% "rm -f /tmp/pull_%PROJECT_NAME%.tar.gz"
  pause
  exit /b 1
)

echo.
echo [3/4] Extracting locally...

tar -xzf "%ARCHIVE%"

if errorlevel 1 (
  echo Local extraction failed.
  del "%ARCHIVE%" >nul 2>&1
  ssh %VPS% "rm -f /tmp/pull_%PROJECT_NAME%.tar.gz"
  pause
  exit /b 1
)

echo.
echo [4/4] Cleaning up...

del "%ARCHIVE%" >nul 2>&1
ssh %VPS% "rm -f /tmp/pull_%PROJECT_NAME%.tar.gz"

echo.
echo =========================================
echo Pull complete!
echo Workspace: %PROJECT_NAME%
echo =========================================
pause
