@echo off
chcp 65001 >nul
title 安装 dsh-workbuddy-bridge
cd /d "%~dp0"
node tools\install.mjs
pause
