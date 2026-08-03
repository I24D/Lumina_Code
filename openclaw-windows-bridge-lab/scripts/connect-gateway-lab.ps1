[CmdletBinding()]
param(
    [string]$GatewayUrl = "ws://localhost:18789",
    [int]$McpPort = 18795
)

$ErrorActionPreference = "Stop"

$labRoot = Split-Path -Parent $PSScriptRoot
$openClawRoot = "C:\I24D_WhatsApp\openclaw-main"
$exe = Join-Path $labRoot "windows-node-source\src\OpenClaw.WinNode.Cli\bin\Debug\net10.0\winnode.exe"
$dataDir = Join-Path $labRoot "tray-data"

if (-not (Test-Path -LiteralPath $exe)) {
    throw "winnode.exe not found. Build WinNodeCli first."
}
if (-not (Test-Path -LiteralPath (Join-Path $openClawRoot "openclaw.mjs"))) {
    throw "openclaw-main CLI not found at $openClawRoot"
}

$env:OPENCLAW_TRAY_DATA_DIR = $dataDir
$env:OPENCLAW_MCP_PORT = [string]$McpPort

Push-Location $openClawRoot
try {
    $setupCode = (& node .\openclaw.mjs qr --setup-code-only --url $GatewayUrl 2>$null | Select-Object -First 1).Trim()
    if (-not $setupCode) {
        throw "No setup code returned by openclaw qr."
    }
} finally {
    Pop-Location
}

$paramsFile = New-TemporaryFile
try {
    @{ setupCode = $setupCode } | ConvertTo-Json -Compress | Set-Content -LiteralPath $paramsFile.FullName -Encoding UTF8
    & $exe --command app.connection.applySetupCode --params "@$($paramsFile.FullName)" --mcp-port $McpPort --identity dev --invoke-timeout 30000
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $paramsFile.FullName -Force -ErrorAction SilentlyContinue
}
