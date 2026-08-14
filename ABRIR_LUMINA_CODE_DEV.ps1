$ErrorActionPreference = "Stop"

$luminaCodeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Join-Path $luminaCodeRoot "continue-upstream"
$guiRoot = Join-Path $sourceRoot "gui"
$extensionRoot = Join-Path $sourceRoot "extensions\vscode"
$workspaceRoot = Join-Path $sourceRoot "manual-testing-sandbox"
$codeCommand = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"
$isolatedRoot = Join-Path $env:LOCALAPPDATA "LuminaCode\DevelopmentHost"
$userDataRoot = Join-Path $isolatedRoot "user-data"
$extensionsRoot = Join-Path $isolatedRoot "extensions"

function Test-LocalPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $connected = $result.AsyncWaitHandle.WaitOne(500) -and $client.Connected
        if ($connected) {
            $client.EndConnect($result)
        }
        $client.Dispose()
        return $connected
    }
    catch {
        return $false
    }
}

function Repair-LanceDbNativeModule {
    if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
        return
    }

    $packageRoot = Join-Path $sourceRoot "core\node_modules\@lancedb\vectordb-win32-x64-msvc"
    $packageFile = Join-Path $packageRoot "package.json"
    $coreBinary = Join-Path $packageRoot "index.node"
    if (-not (Test-Path -LiteralPath $packageFile) -or -not (Test-Path -LiteralPath $coreBinary)) {
        return
    }

    & node.exe -e "require(process.argv[1])" $coreBinary *> $null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "Repairing the truncated LanceDB native module..."
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    $packageSpec = "$($package.name)@$($package.version)"
    $repairRoot = Join-Path $env:TEMP ("lumina-lancedb-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $repairRoot | Out-Null

    try {
        & npm.cmd pack $packageSpec --silent --pack-destination $repairRoot | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to download $packageSpec."
        }
        $archive = Get-ChildItem -LiteralPath $repairRoot -Filter "*.tgz" | Select-Object -First 1
        if (-not $archive) {
            throw "The LanceDB repair archive was not created."
        }
        & tar.exe -xf $archive.FullName -C $repairRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to extract the LanceDB repair archive."
        }

        $candidate = Join-Path $repairRoot "package\index.node"
        & node.exe -e "require(process.argv[1])" $candidate *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "The downloaded LanceDB native module is invalid."
        }

        $targets = @(
            $coreBinary,
            (Join-Path $extensionRoot "node_modules\@lancedb\vectordb-win32-x64-msvc\index.node"),
            (Join-Path $extensionRoot "out\node_modules\@lancedb\vectordb-win32-x64-msvc\index.node")
        )
        foreach ($target in $targets) {
            if (Test-Path -LiteralPath $target) {
                Copy-Item -LiteralPath $candidate -Destination $target -Force
            }
        }
    }
    finally {
        $resolvedRepairRoot = [IO.Path]::GetFullPath($repairRoot)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (
            (Test-Path -LiteralPath $resolvedRepairRoot) -and
            $resolvedRepairRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedRepairRoot).StartsWith("lumina-lancedb-")
        ) {
            [IO.Directory]::Delete($resolvedRepairRoot, $true)
        }
    }
}

if (-not (Test-Path -LiteralPath $codeCommand)) {
    $resolvedCode = Get-Command code.cmd -ErrorAction SilentlyContinue
    if (-not $resolvedCode) {
        throw "Visual Studio Code was not found."
    }
    $codeCommand = $resolvedCode.Source
}

foreach ($requiredPath in @($guiRoot, $extensionRoot, $workspaceRoot)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required development path was not found: $requiredPath"
    }
}

Repair-LanceDbNativeModule

if (-not (Test-LocalPort -Port 5174)) {
    Write-Host "Starting the Lumina Code development UI on port 5174..."
    Start-Process -FilePath "npm.cmd" `
        -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", "5174") `
        -WorkingDirectory $guiRoot `
        -WindowStyle Hidden | Out-Null

    $guiReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        if (Test-LocalPort -Port 5174) {
            $guiReady = $true
            break
        }
    }
    if (-not $guiReady) {
        throw "The Lumina Code development UI did not start on port 5174."
    }
}

Write-Host "Compiling the Lumina Code extension..."
Push-Location $extensionRoot
try {
    & npm.cmd run esbuild
    if ($LASTEXITCODE -ne 0) {
        throw "The Lumina Code extension build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $userDataRoot, $extensionsRoot | Out-Null

# Optional skill folders can be supplied through LUMINA_SKILLS_DIR. The public
# launcher intentionally avoids private, machine-specific paths.

# Personal-app automation is opt-in. Use "dry" for drafts only or "1" to enable
# sending after reviewing the implementation and its permissions.
if ([string]::IsNullOrWhiteSpace($env:LUMINA_WHATSAPP_AUTOREPLY)) {
    $env:LUMINA_WHATSAPP_AUTOREPLY = "0"
}

Write-Host "Opening an isolated Lumina Code Development Host..."
Write-Host "The current VS Code and Codex windows will remain untouched."
Start-Process -FilePath $codeCommand -ArgumentList @(
    "--new-window",
    "--user-data-dir=$userDataRoot",
    "--extensions-dir=$extensionsRoot",
    "--extensionDevelopmentPath=$extensionRoot",
    $workspaceRoot
) | Out-Null
