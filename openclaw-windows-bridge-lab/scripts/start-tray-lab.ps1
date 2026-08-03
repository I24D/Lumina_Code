[CmdletBinding()]
param(
    [int]$McpPort = 18795,
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

$labRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $labRoot
$sourceRoot = Join-Path $labRoot "windows-node-source"
$dataDir = Join-Path $labRoot "tray-data"
$launcher = Join-Path $sourceRoot "run-app-local.ps1"

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Windows node source not found. Expected: $launcher"
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = @($machinePath, $userPath) -join ";"
$env:OPENCLAW_MCP_PORT = [string]$McpPort

$envFile = Join-Path $workspaceRoot ".env"
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            continue
        }

        $separator = $line.IndexOf("=")
        if ($separator -le 0) {
            continue
        }

        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

$launchArgs = @{
    Dev = $true
    DataDir = $dataDir
}
if ($NoBuild) {
    $launchArgs["NoBuild"] = $true
}

Push-Location $sourceRoot
try {
    & $launcher @launchArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

Write-Host "Lab tray requested on MCP port $McpPort"
Write-Host "Data dir: $dataDir"
