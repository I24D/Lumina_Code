[CmdletBinding()]
param(
    [int]$McpPort = 18795
)

$ErrorActionPreference = "Stop"

$labRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $labRoot "windows-node-source\src\OpenClaw.WinNode.Cli\bin\Debug\net10.0\winnode.exe"
$dataDir = Join-Path $labRoot "tray-data"

if (-not (Test-Path -LiteralPath $exe)) {
    throw "winnode.exe not found. Build WinNodeCli first."
}

$env:OPENCLAW_TRAY_DATA_DIR = $dataDir
$env:OPENCLAW_MCP_PORT = [string]$McpPort

Write-Host "Testing MCP tools on http://127.0.0.1:$McpPort/"
& $exe --list-tools --mcp-port $McpPort --identity dev --invoke-timeout 10000
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Testing system.which..."
$whichParams = New-TemporaryFile
try {
    '{"bins":["git","node","powershell"]}' | Set-Content -LiteralPath $whichParams.FullName -Encoding UTF8
    & $exe --command system.which --params "@$($whichParams.FullName)" --mcp-port $McpPort --identity dev --invoke-timeout 10000
} finally {
    Remove-Item -LiteralPath $whichParams.FullName -Force -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Testing tts.status..."
& $exe --command tts.status --params '{}' --mcp-port $McpPort --identity dev --invoke-timeout 10000
exit $LASTEXITCODE
