param(
  [ValidateSet("build", "dev")]
  [string]$Mode = "build"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if ($cargo) {
  $rustBin = Split-Path -Parent $cargo.Source
} else {
  $rustBin = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
  if (-not (Test-Path -LiteralPath (Join-Path $rustBin "cargo.exe"))) {
    throw "No se encontro cargo.exe. Instala el toolchain estable de Rust MSVC."
  }
}

$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
  throw "No se encontro vswhere.exe de Visual Studio Build Tools."
}

$buildTools = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $buildTools) {
  throw "No se encontraron Visual Studio Build Tools con soporte C++ x64."
}

$vsDevCmd = Join-Path $buildTools "Common7\Tools\VsDevCmd.bat"
$env:PATH = "$(Split-Path -Parent $vswhere);$env:PATH"
$environment = & cmd.exe /d /s /c "`"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64 && set"
if ($LASTEXITCODE -ne 0) {
  throw "VsDevCmd.bat no pudo preparar el entorno de compilacion."
}

foreach ($line in $environment) {
  if ($line -match "^([^=]+)=(.*)$") {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
  }
}

$env:PATH = "$rustBin;$env:PATH"
Set-Location -LiteralPath $projectRoot

$tauri = Join-Path $projectRoot "node_modules\.bin\tauri.cmd"
if (-not (Test-Path -LiteralPath $tauri)) {
  Write-Host "Installing Start Talk build dependencies..."
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    throw "Start Talk dependencies could not be installed."
  }
}

& npm.cmd run $Mode
exit $LASTEXITCODE
