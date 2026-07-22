@echo off
echo Pushing updates to GitHub and Vercel...
if exist "%~dp0.git\index.lock" del "%~dp0.git\index.lock"
git add .
git commit -m "Vibe coding update"
git push
echo Done!
timeout /t 2 >nul