param()

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Require-Command($Name, $Message) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw $Message
  }
}

Push-Location $root
try {
  Require-Command "node" "Node.js was not found. Install Node.js 20 or 22 LTS, then run install.ps1 again."
  Require-Command "npm" "npm was not found. Reinstall Node.js with npm enabled, then run install.ps1 again."

  $major = [int](& node -p "Number(process.versions.node.split('.')[0])")
  if ($major -lt 18) {
    throw "Node.js 18.18.0 or newer is required. Node.js 20 or 22 LTS is recommended on Windows."
  }

  Write-Host "Installing production dependencies..."
  & npm install --omit=dev
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed. better-sqlite3 is a native dependency; prefer Node.js 20/22 LTS. If npm builds from source, install Visual Studio Build Tools with Desktop development with C++."
  }

  Write-Host ""
  Write-Host "ace-mcp is installed."
  Write-Host "Start Web UI: .\start-web.cmd or powershell -ExecutionPolicy Bypass -File .\start-web.ps1"
  Write-Host "MCP command after global npm install: $env:APPDATA\npm\ace-mcp.cmd"
}
finally {
  Pop-Location
}
