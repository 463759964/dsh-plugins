@echo off
chcp 65001 >nul
title WorkBuddy 今日积分
cd /d "%~dp0"
node tools\credits.mjs --watch 10
pause
