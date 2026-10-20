@echo off
setlocal
title 售服系統伺服器

cd /d "%~dp0"
set "SERVICE_DESK_HOST=0.0.0.0"
set "SERVICE_DESK_PORT=8080"

where node >nul 2>&1
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝 Node.js 22 以上版本。
  echo.
  pause
  exit /b 1
)

echo 正在啟動售服系統...
echo 其他電腦請使用本機 IPv4 位址加上 :8080 連線。
start "" "http://127.0.0.1:8080"
node server.js

echo.
echo 售服系統已停止。若要重新啟動，請再次雙擊這個檔案。
pause
