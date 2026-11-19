@echo off
setlocal
pushd "%~dp0" || goto folder_error

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto node_error

if not defined HOST set "HOST=127.0.0.1"
if not defined PORT set "PORT=4173"
echo Open http://127.0.0.1:%PORT%/ in your browser once the tracker is listening.
echo Press Ctrl+C to stop the tracker.
echo.
node server.mjs
set "RESULT=%ERRORLEVEL%"
popd
if "%RESULT%"=="0" exit /b 0
echo.
echo The tracker stopped with an error. See the message above.
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
