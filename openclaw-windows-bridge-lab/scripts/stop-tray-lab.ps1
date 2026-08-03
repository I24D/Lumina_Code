[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Get-Process -Name "OpenClaw.Tray.WinUI" -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            $_.Path -like "*openclaw-windows-bridge-lab*"
        } catch {
            $false
        }
    } |
    Stop-Process -Force

Write-Host "Stopped lab tray processes if any were running."
