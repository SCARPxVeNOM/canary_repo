@echo off
REM Canary live check: install, build, then run scripts\live-check.mjs over real tor-js.
REM Double-click this file. Output also goes to live-check.log; the summary to live-check.json.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed: get Node 22+ from https://nodejs.org & pause & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do if %%v LSS 22 (echo Node 22+ needed, found & node --version & pause & exit /b 1)
echo === npm install === > live-check.log
call npm install --no-audit --no-fund >> live-check.log 2>&1 || (echo npm install failed, see live-check.log & pause & exit /b 1)
echo === npm run build === >> live-check.log
call npm run build >> live-check.log 2>&1 || (echo build failed, see live-check.log & pause & exit /b 1)
echo === live check (tor-js boots in about 15 s, up to 3 min) ===
call npm run live-check -- %* > live-check.run.log 2>&1
type live-check.run.log
type live-check.run.log >> live-check.log
del live-check.run.log
echo.
echo Done. Tell Claude "done": it reads live-check.json and live-check.log from this folder.
pause
