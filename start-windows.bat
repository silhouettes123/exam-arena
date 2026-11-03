@echo off
chcp 65001 >nul
title 抢答星球 · 考试平台
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没有找到 Node.js，请先安装： https://nodejs.org/
  pause
  exit /b 1
)

echo ============================================
echo   用户端  http://localhost:8095/
echo   管理端  http://localhost:8095/admin
echo   默认密码 admin123
echo ============================================
echo 关闭本窗口即停止服务。
echo.
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:8095/admin"
node server.js
pause
