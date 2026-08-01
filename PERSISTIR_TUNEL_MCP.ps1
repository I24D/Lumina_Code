# Persistir el tunel de Cloudflare (MCP Gateway) como servicio de Windows.
#
# El servicio 'cloudflared' quedo instalado con un ImagePath SIN argumentos
# (le faltaba `tunnel --config ... run`), por eso arrancaba pero no conectaba el
# tunel. Este script corrige el ImagePath, activa auto-reinicio y lo levanta,
# para que mcp.luminaopenia.com quede arriba al encender el PC sin dejar ninguna
# ventana de PowerShell abierta.
#
# Uso: click derecho > Ejecutar con PowerShell, o simplemente ejecutarlo; se
# auto-eleva (UAC).

$ErrorActionPreference = 'Stop'

# --- Auto-elevacion ---
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Elevando (aceptar el UAC)..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
  )
  return
}

$exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$cfg = 'C:\Users\dal_n\.cloudflared\config.yml'

if (-not (Test-Path $exe)) { throw "No existe cloudflared.exe en: $exe" }
if (-not (Test-Path $cfg)) { throw "No existe config.yml en: $cfg" }

Write-Host "Deteniendo el servicio cloudflared (con timeout)..." -ForegroundColor Cyan
# El proceso a veces ignora el stop limpio y 'Stop-Service' se cuelga esperando.
# Pedimos el stop en background y, si no cede en 8s, matamos los procesos a la fuerza.
$stopJob = Start-Job { param($ErrorActionPreference='SilentlyContinue') Stop-Service cloudflared -Force -ErrorAction SilentlyContinue }
if (-not (Wait-Job $stopJob -Timeout 8)) {
  Write-Host "  El servicio no cedio; forzando taskkill de cloudflared.exe..." -ForegroundColor Yellow
}
Remove-Job $stopJob -Force -ErrorAction SilentlyContinue
& taskkill.exe /f /im cloudflared.exe /t 2>$null | Out-Null
Start-Sleep -Seconds 2
Write-Host "  Procesos cloudflared detenidos." -ForegroundColor Cyan

# Corregir el ImagePath para que ejecute el tunel con la config del usuario.
# Escribir el registro directamente evita el infierno de comillas de sc.exe.
$imagePath = '"{0}" tunnel --config "{1}" run' -f $exe, $cfg
$svcKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared'
if (-not (Test-Path $svcKey)) { throw "No existe el servicio 'cloudflared'. Instalalo antes con: & '$exe' service install" }

Write-Host "Corrigiendo ImagePath -> $imagePath" -ForegroundColor Cyan
Set-ItemProperty -Path $svcKey -Name ImagePath -Value $imagePath

# Auto-reinicio ante fallos (reintenta a los 5s, resetea contador a los 60s).
Write-Host "Configurando auto-reinicio ante fallos..." -ForegroundColor Cyan
& sc.exe failure cloudflared reset= 60 actions= restart/5000/restart/5000/restart/5000 | Out-Null

# Arranque automatico + levantar ahora.
Set-Service cloudflared -StartupType Automatic
Write-Host "Arrancando el servicio..." -ForegroundColor Cyan
Start-Service cloudflared

Start-Sleep -Seconds 5
$svc = Get-Service cloudflared
Write-Host ("Servicio: {0} / {1} / {2}" -f $svc.Name, $svc.Status, $svc.StartType) -ForegroundColor Green

# Verificacion publica (puede tardar unos segundos en registrar la conexion).
Write-Host "Verificando https://mcp.luminaopenia.com/health ..." -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://mcp.luminaopenia.com/health' -TimeoutSec 5
    Write-Host "  -> $($r.StatusCode) $($r.Content)" -ForegroundColor Green
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 3
  }
}
if (-not $ok) {
  Write-Host "  Aun no responde por el tunel. Revisa los logs del servicio en el Visor de eventos." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "LISTO. Ahora puedes CERRAR la ventana de PowerShell donde corrias 'cloudflared tunnel run'" -ForegroundColor Green
Write-Host "en primer plano: el servicio ya mantiene el tunel por su cuenta." -ForegroundColor Green
Write-Host ""
Write-Host "Pulsa Enter para cerrar..."
[void][System.Console]::ReadLine()
