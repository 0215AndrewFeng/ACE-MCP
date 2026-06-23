@echo off
setlocal

pushd "%~dp0.." >nul

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or 22 LTS, then run install.cmd again.
  popd >nul
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled, then run install.cmd again.
  popd >nul
  exit /b 1
)

for /f %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo Node.js 18.18.0 or newer is required. Node.js 20 or 22 LTS is recommended on Windows.
  popd >nul
  exit /b 1
)

echo Installing production dependencies...
npm install --omit=dev
if errorlevel 1 (
  echo.
  echo Install failed. better-sqlite3 is a native dependency; use Node.js 20/22 LTS first.
  echo If npm still builds from source, install Visual Studio Build Tools with Desktop development with C++.
  popd >nul
  exit /b 1
)

echo.
echo ace-mcp is installed.
echo Running local health check...
node dist\index.js --doctor
if errorlevel 1 (
  echo.
  echo ace-mcp doctor found an installation problem. Review the messages above and run install.cmd again after fixing it.
  popd >nul
  exit /b 1
)
echo.
echo Start Web UI: start-web.cmd
echo MCP command after global npm install: %%APPDATA%%\npm\ace-mcp.cmd

popd >nul
