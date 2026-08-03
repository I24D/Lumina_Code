[CmdletBinding()]
param(
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

$labRoot = Split-Path -Parent $PSScriptRoot
$bridgeDir = Join-Path $labRoot "lumina-windows-bridge"
$repoRoot = "C:\I24D_WhatsApp\Lumina_PC"
$envFile = "C:\I24D_WhatsApp\.env"

if (-not (Test-Path -LiteralPath (Join-Path $bridgeDir "src\server.ts"))) {
    throw "Lumina bridge source not found: $bridgeDir"
}

$env:LUMINA_REPO_ROOT = $repoRoot
$env:I24D_ENV_FILE = $envFile
$env:LUMINA_BRIDGE_PORT = [string]$Port

$node = Get-Command node -ErrorAction Stop
$process = Start-Process `
    -FilePath $node.Source `
    -ArgumentList @("--experimental-strip-types", "src/server.ts") `
    -WorkingDirectory $bridgeDir `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Started Lumina Windows Bridge (PID: $($process.Id))"
Write-Host "Endpoint: http://127.0.0.1:$Port"
Write-Host "Source: $bridgeDir"
Write-Host "Repo root: $repoRoot"
