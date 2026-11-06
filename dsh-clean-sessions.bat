@echo off
setlocal enabledelayedexpansion
title DSH 会话数据一键清理

rem ============ 通用版：自动定位，不写死用户名与盘符 ============
set "SYS=%SystemRoot%\System32"
set "ROOT="
set "APP="

rem 1) 定位 .dsh 数据根目录
if defined DSH_HOME if exist "%DSH_HOME%" set "ROOT=%DSH_HOME%"
if not defined ROOT if exist "%USERPROFILE%\.dsh" set "ROOT=%USERPROFILE%\.dsh"
if not defined ROOT if exist "%LOCALAPPDATA%\.dsh" set "ROOT=%LOCALAPPDATA%\.dsh"
if not defined ROOT for /d %%D in ("%USERPROFILE%\*.dsh*") do set "ROOT=%%~fD"

rem 2) 定位客户端配置目录（DSH Desktop / DeepSeek 系命名差异）
if exist "%APPDATA%\DSH Desktop" set "APP=%APPDATA%\DSH Desktop"
if not defined APP for /d %%D in ("%APPDATA%\DSH*") do set "APP=%%~fD"
if not defined APP for /d %%D in ("%APPDATA%\DeepSeek*") do set "APP=%%~fD"

echo ============================================================
echo    DSH 会话数据一键清理（通用版）
echo ============================================================
echo.

if not defined ROOT goto nodata
echo 数据目录: %ROOT%
if defined APP echo 配置目录: %APP%
if not defined APP echo 配置目录: 未找到（将只清理数据目录）
echo.

set "T1=%ROOT%\sessions"
set "T2=%ROOT%\storages"
set "T3=%ROOT%\attachments"
set "T4=%ROOT%\cache"
set "T5=%ROOT%\dsh-roost"
set "T6=%ROOT%\our-free-model\session-map.json"
set "T7="
set "T8="
set "T9="
if defined APP set "T7=%APP%\Local Storage"
if defined APP set "T8=%APP%\Session Storage"
if defined APP set "T9=%APP%\blob_storage"

"%SYS%\tasklist.exe" /FI "IMAGENAME eq DSH Desktop.exe" 2>nul | "%SYS%\find.exe" /i "DSH Desktop.exe" >nul
if not errorlevel 1 echo [提示] DSH Desktop 正在运行，个别文件可能被占用，退出程序后运行更彻底。
"%SYS%\tasklist.exe" /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | "%SYS%\find.exe" /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 echo [提示] DeepSeek Harness 正在运行，个别文件可能被占用。
echo.

echo 将清空以下位置（不存在则自动跳过）:
echo   %T1%
echo   %T2%
echo   %T3%
echo   %T4%
echo   %T5%
echo   %T6%
if defined T7 echo   %T7%
if defined T8 echo   %T8%
if defined T9 echo   %T9%
echo.
echo 会先自动备份到桌面，再永久删除。
echo.
echo    ^>^>^> 按回车开始清理，直接关窗口即取消 ^<^<^<
pause >nul
echo.

echo [1/2] 备份中...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ts=Get-Date -Format 'yyyyMMdd-HHmmss'; $d=Join-Path ([Environment]::GetFolderPath('Desktop')) ('dsh-session-backup-'+$ts+'.zip'); $src=@('%T1%','%T2%','%T3%','%T4%','%T5%','%T6%','%T7%','%T8%','%T9%') | Where-Object { $_ -and (Test-Path $_) }; if($src.Count -gt 0){ Compress-Archive -Path $src -DestinationPath $d -CompressionLevel Optimal -Force; if(Test-Path $d){ Write-Host ('    已备份: '+$d) } else { Write-Host '    备份失败，已中止'; exit 1 } } else { Write-Host '    无可备份内容' }"
if errorlevel 1 goto abort

echo [2/2] 删除中...
call :KILL "%T1%"
call :KILL "%T2%"
call :KILL "%T3%"
call :KILL "%T4%"
call :KILL "%T5%"
call :KILL "%T6%"
call :KILL "%T7%"
call :KILL "%T8%"
call :KILL "%T9%"

echo.
echo 清理完成。备份在桌面 dsh-session-backup-*.zip，确认无误后可自行删除。
echo.
pause
exit /b 0

:nodata
echo 未找到 DSH 数据目录（.dsh）。
echo 若程序装在其它位置，请把本脚本里的 ROOT 手动改到实际目录。
echo.
pause
exit /b 1

:abort
echo 备份失败，为避免数据丢失已中止，未删除任何内容。
echo.
pause
exit /b 1

:KILL
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
rd /s /q "%~1" >nul 2>&1
if exist "%~1" echo   [失败] %~1   ^(被占用^)
if not exist "%~1" echo   [已删除] %~1
exit /b 0
