@echo off
echo Pushing updates to GitHub and Vercel...
git add .
git commit -m "Vibe coding update"
git push
echo Done!
timeout /t 2 >nul