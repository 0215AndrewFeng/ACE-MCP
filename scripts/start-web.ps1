param(
  [Parameter(Position = 0)]
  [string]$PortOrArg,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entryPath = Join-Path $scriptDir "../dist/index.js"
$port = if ($env:ACE_MCP_WEB_PORT) { $env:ACE_MCP_WEB_PORT } else { "8787" }
$extraArgs = @()

if ($PortOrArg) {
  if ($PortOrArg -match '^\d+$') {
    $port = $PortOrArg
    $extraArgs = $Rest
  } else {
    $extraArgs = @($PortOrArg) + $Rest
  }
}

& node $entryPath --web-port $port @extraArgs
exit $LASTEXITCODE
