[CmdletBinding()]
param(
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

$isLuminaBridge = $false
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 3
    $isLuminaBridge = $health.service -eq "lumina-windows-bridge"
} catch {
    $isLuminaBridge = $false
}

if (-not $isLuminaBridge) {
    Write-Host "No Lumina Windows Bridge health response on port $Port."
    exit 0
}

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($connection in $connections) {
    Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped Lumina Windows Bridge PID $($connection.OwningProcess)."
}
