@echo off
cd /d "%~dp0"
echo ChangeRelay opens at http://localhost:54880
echo Keep this window open during your demonstration.
node --env-file-if-exists=.env server.mjs
pause
