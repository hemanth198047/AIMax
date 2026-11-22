@echo off
rem Stops a running AImax (anything listening on its ports 3001 / 5173).
cd /d %~dp0
node scripts\aimax-start.mjs --stop
pause
