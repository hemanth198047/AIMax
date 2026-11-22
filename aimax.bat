@echo off
rem Starts everything AImax needs. Extra options: --force  --reinstall  --no-open  --no-ollama  --check
cd /d %~dp0
where node >nul 2>nul || (echo Node.js 20 or newer is required. Install the LTS from https://nodejs.org & pause & exit /b 1)
node scripts\aimax-start.mjs %*
if errorlevel 1 pause
