@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title PDF Board
chcp 65001 >nul 2>nul

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  "%NODE_EXE%" "server.mjs"
) else (
  "%NODE_EXE%" "server.mjs" "%~1"
)

if errorlevel 1 pause
