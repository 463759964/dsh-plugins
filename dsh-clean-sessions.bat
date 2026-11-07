@echo off
setlocal enabledelayedexpansion
title DSH 会话数据一键清理（免备份直删版）

rem ============ 通用版：自动定位数据目录与客户端缓存目录 ============
set "SYS=%SystemRoot%\System32"
set "ROOT="
set "APP="

rem 1) 定位 .dsh 数据根目录
if defined DSH_HOME if exist "%DSH_HOME%" set "ROOT=%DSH_HOME%"
if not defined ROOT if exist "%USERPROFILE%\.dsh" set "ROOT=%USERPROFILE%\.dsh"
if not defined ROOT if exist "%LOCALAPPDATA%\.dsh" set "ROOT=%LOCALAPPDATA%\.dsh"
if not defined ROOT for /d %%D in ("%USERPROFILE%\*.dsh*") do set "ROOT=%%~fD"

rem 2) 定位客户端数据目录（DSH Desktop / DeepSeek 系列，取先匹配者）
if exist "%APPDATA%\DSH Desktop" set "APP=%APPDATA%\DSH Desktop"
if not defined APP for /d %%D in ("%APPDATA%\DSH*") do set "APP=%%~fD"
if not defined APP for /d %%D in ("%APPDATA%\DeepSeek*") do set "APP=%%~fD"

echo ============================================================
echo    DSH 会话数据一键清理（免备份直删版）
echo ============================================================
echo.

if not defined ROOT goto nodata
echo 数据目录: %ROOT%
if defined APP echo 应用目录: %APP%
if not defined APP echo 应用目录: 未找到（将只清理数据目录）
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
if not errorlevel 1 echo [提示] DSH Desktop 正在运行，部分文件可能被占用，退出后重试删得更干净。
"%SYS%\tasklist.exe" /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | "%SYS%\find.exe" /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 echo [提示] DeepSeek Harness 正在运行，部分文件可能被占用。
echo.

echo 即将【直接删除、不做任何备份】以下位置（如存在）:
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
echo 注意：本版本不会创建 zip 备份，删除后不可恢复！
echo.
echo    ^>^>^> 按回车开始删除，直接关窗口即取消 ^<^<^<
pause >nul
echo.

echo 正在删除...
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
echo 清理完成（本版本无备份，数据已不可恢复）。
echo.
pause
exit /b 0

:nodata
echo 未找到 DSH 数据目录（.dsh）。
echo 如果你装在别的位置，请编辑脚本把 ROOT 手动指到实际目录。
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
