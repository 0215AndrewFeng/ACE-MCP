@echo off
setlocal

set "PORT=%ACE_MCP_WEB_PORT%"
if "%PORT%"=="" set "PORT=8787"

if not "%~1"=="" (
  echo %~1| findstr /R "^[0-9][0-9]*$" >nul
  if not errorlevel 1 (
    set "PORT=%~1"
    shift
  )
)

node "%~dp0..\dist\index.js" --web-port "%PORT%" %*
exit /b %ERRORLEVEL%
