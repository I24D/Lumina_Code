[CmdletBinding()]
param(
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 5
if ($health.service -ne "lumina-windows-bridge") {
    throw "Unexpected service on port ${Port}: $($health.service)"
}

$schema = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/schema" -Method Get -TimeoutSec 5

[pscustomobject]@{
    ok = $true
    service = $health.service
    repoRoot = $health.repoRoot
    runtimeDir = $health.runtimeDir
    endpointCount = @($health.endpoints).Count
    schemaOk = [bool]$schema.ok
} | ConvertTo-Json -Depth 6
