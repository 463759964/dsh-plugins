@echo off
rem Start the WorkBuddy bridge in a minimized window.
rem Double-click this file if you do not want DSH to host the bridge itself.
setlocal
cd /d "%~dp0"

set "NODE_BIN="
for %%N in (node) do if not defined NODE_BIN (
  where %%N >nul 2>nul && set "NODE_BIN=%%N"
)
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"
if not defined NODE_BIN if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

if not defined NODE_BIN (
  echo [workbuddy-bridge] node.exe not found. Install Node.js 18+ and try again.
  pause
  exit /b 1
)

echo [workbuddy-bridge] starting on http://127.0.0.1:8792
echo [workbuddy-bridge] models: http://127.0.0.1:8792/v1/models
echo [workbuddy-bridge] press Ctrl+C in this window to stop.
"%NODE_BIN%" lib\serve.mjs --port 8792
endlocal
