@echo off
setlocal
pushd "%~dp0" || goto folder_error

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto node_error

echo Press Ctrl+C to stop Solid Tracker.
echo.
node server.mjs
set "RESULT=%ERRORLEVEL%"
popd
if "%RESULT%"=="0" exit /b 0
echo.
echo Solid Tracker stopped with an error. See the message above.
pause
exit /b %RESULT%

:node_error
echo Node.js 22 or newer is required.
echo Install the Windows LTS release from https://nodejs.org/en/download and try again.
popd
pause
exit /b 1

:folder_error
echo Could not open the tracker folder. Extract the ZIP before running this file.
pause
exit /b 1
