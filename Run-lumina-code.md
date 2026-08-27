# Ejecutar Lumina Code en modo desarrollador

Ultima actualizacion: 2026-08-15.

Este documento es la fuente de verdad para volver a levantar el proyecto desde
cero (por ejemplo despues de apagar el PC). El flujo actual conserva solo:

- Lumina Code dentro de un VS Code Extension Development Host aislado.
- Start Talk como orbe nativo Windows lanzado desde Lumina Code.
- Windows Bridge (`:8765`) y Lumina MCP Gateway (`:8808`) como runtime de
  apoyo, mas Lumina Core (`:3000`) y Model Router cuando se necesiten.

Los proyectos externos no se arrancan, empaquetan ni supervisan desde Lumina
Code.

## Comando Oficial

Abrir PowerShell y ejecutar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Lumina Code\ABRIR_LUMINA_CODE_DEV.ps1"
```

> El script se autolocaliza (`Split-Path -Parent $MyInvocation.MyCommand.Path`),
> asi que funciona desde donde este el repo. Lo que NO se puede es cambiarlo de
> carpeta sin llevarse `continue-upstream/` con el. Las comillas son
> obligatorias: la ruta lleva un espacio en "Lumina Code".

El launcher hace cinco cosas, en este orden:

1. Repara el modulo nativo de LanceDB si quedo truncado (lo re-descarga).
2. Repara/copia el binding nativo de SQLite.
3. Arranca la UI dev de Lumina Code en `127.0.0.1:5174` **solo si no esta viva**
   (espera hasta 20 s a que el puerto responda).
4. Compila la extension (`npm run esbuild` en `continue-upstream/extensions/vscode`).
5. Abre un VS Code Extension Development Host aislado, con su propio
   `user-data-dir` y `extensions-dir` en `%LOCALAPPDATA%\LuminaCode\DevelopmentHost`,
   sobre el workspace `continue-upstream/manual-testing-sandbox`.

Las ventanas de VS Code y Codex que ya tengas abiertas no se tocan.

## Start Talk

Start Talk se abre **desde la paleta de comandos del Dev Host**:

```text
Lumina Code: Start Talk (orbe de escritorio)
```

Ese comando es importante porque crea el `OrbBridgeServer` (WebSocket en
`127.0.0.1`, puerto efimero + token de sesion) y lanza
`Start-talk\src-tauri\target\release\start-talk.exe` con `LUMINA_ORB_BRIDGE`.
Si se ejecuta el `.exe` a mano, la ventana nativa abre pero no responde: no
tiene puente con Lumina Code.

Requisito: la clave del proveedor de voz en el `.env` de la raiz.
`OPENAI_API_KEY` para la configuracion por defecto (`gpt-realtime-2.1`, voz
`marin`), o `GEMINI_API_KEY` si prefieres Gemini Live.

## Que hay que reconstruir segun lo que toques

Esto es lo que mas tiempo hace perder. El frontend del orbe va **embebido
dentro del exe** en tiempo de compilacion, asi que no todos los cambios se ven
igual de rapido:

| Tocaste | Reconstruir | Como se ve el cambio |
|---|---|---|
| `continue-upstream/core/**` | `npm run esbuild` en `extensions/vscode` | Recargar el Dev Host |
| `continue-upstream/extensions/vscode/**` | igual que arriba | Recargar el Dev Host |
| `continue-upstream/gui/**` (incluye la UI de Start Talk) | build de gui + ensamblar `orb-frontend` + recompilar el exe | Reiniciar el orbe |

### Reconstruir el orbe completo (cambios de GUI)

```powershell
# 1. Bundle de la GUI
Set-Location "C:\Lumina Code\continue-upstream\gui"
npm run build

# 2. Ensamblar orb-frontend desde gui/dist
$dist = "C:\Lumina Code\continue-upstream\gui\dist"
$orb  = "C:\Lumina Code\Start-talk\orb-frontend"
foreach ($d in @("assets","fonts","logos")) {
  if (Test-Path "$orb\$d") { Remove-Item "$orb\$d" -Recurse -Force }
  Copy-Item "$dist\$d" "$orb\$d" -Recurse -Force
}
Copy-Item "$dist\*.html" $orb -Force
Copy-Item "$dist\*.png"  $orb -Force

# 3. Recompilar el exe
Set-Location "C:\Lumina Code\Start-talk\src-tauri"
cargo build --release      # ~7 min en frio
```

Tres avisos que cuestan caro si se ignoran:

- ⚠️ **Borrar los directorios destino ANTES de copiar.** Si no, PowerShell anida
  (`assets/assets/...`) y el exe termina embebiendo el bundle viejo sin que nada
  falle visiblemente.
- ⚠️ **`orb-frontend/index.html` SÍ hay que copiarlo.** Antes este documento
  decía lo contrario — que era un shim propio que falseaba `window.vscode` —, y
  era falso: se comprobó y el fichero es byte a byte el de `gui/dist`. El puente
  `window.vscode` sobre WebSocket lo inyecta `src-tauri/src/lib.rs` como init
  script, no el HTML. Si no se recopia, el orbe queda pidiendo la entrada del
  bundle anterior y la ventana abre en negro sin que la compilación falle.
  `npm run check` en `Start-talk` detecta justo ese desajuste.
- ⚠️ **El exe suele estar bloqueado** porque el orbe está corriendo y el
  supervisor lo relanza si se mata abruptamente. Cierra su ventana de forma
  normal y compila siempre mediante el script oficial:

  ```powershell
  Get-Process start-talk -ErrorAction SilentlyContinue |
    ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Set-Location "C:\Lumina Code\Start-talk"
  npm run build
  ```

  No renombres el ejecutable ni crees `start-talk.old.exe`. El `postbuild`
  elimina automáticamente la caché binaria, incluidas las copias de `deps` o
  `debug`, y conserva solamente
  `src-tauri\target\release\start-talk.exe`.

Comprobar que el bundle embebido es el recien construido:

```powershell
Get-Item "C:\Lumina Code\Start-talk\orb-frontend\assets\index.js" | Select-Object LastWriteTime
Get-Item "C:\Lumina Code\Start-talk\src-tauri\target\release\start-talk.exe" | Select-Object LastWriteTime
# El exe tiene que ser MAS NUEVO que el index.js
```

## Servicios de apoyo (estado real al 2026-08-15)

| Pieza | Puerto | Estado ahora | Para que hace falta |
|---|---|---|---|
| UI dev de Lumina Code | 5174 | la levanta el launcher | Dev Host |
| Windows Bridge | 8765 | arriba | `pc_*`, `whatsapp_respond`, notificaciones de Start Talk |
| Lumina MCP Gateway | 8808 | **caido** | origen del tunel `mcp.luminaopenia.com` |
| Lumina Core | 3000 | **caido** | `memory_recall` / `memory_save` |

Arranque manual de los dos node (cada uno autocarga el `.env` de la raiz, no
hay que inyectar variables):

```powershell
Set-Location "C:\Lumina Code\Lumina_PC\apps\lumina-windows-bridge"
node --experimental-strip-types src\server.ts

Set-Location "C:\Lumina Code\Lumina_PC\apps\lumina-mcp-gateway"
node --experimental-strip-types src\server.ts
```

**Ninguno de los dos es servicio de Windows: si reinicias el PC hay que
relanzarlos a mano.**

### Tunel de Cloudflare (canal MCP con la app de Claude)

⚠️ **En esta maquina cloudflared NO esta instalado ahora mismo**: no existe el
servicio, no esta en PATH, y faltan tanto
`C:\Program Files (x86)\cloudflared\cloudflared.exe` como
`C:\Users\dal_n\.cloudflared\config.yml`. `PERSISTIR_TUNEL_MCP.ps1` fallaria al
arrancar. Mientras siga asi, `mcp.luminaopenia.com` no puede responder y el
conector MCP de la app de Claude quedara desconectado.

Todo lo local (Lumina Code, Start Talk, el chat, el agente) funciona igual sin
el tunel: solo afecta al canal remoto de la app de Claude.

Para que `lumina_code_chat` responda hace falta ademas tener **la barra lateral
de Lumina Code abierta** en el Dev Host: al abrirla la extension publica
`~/.lumina/mcp-bridge.json`; sin eso devuelve `chat_bridge_unavailable` aunque
el resto de tools ya funcione.

## No Usar

- `setup.exe` durante desarrollo.
- Navegador para Start Talk.
- Ejecutar `Start-talk` con `npm run dev` para probar el orbe nativo.
- Arrancar proyectos externos desde este launcher.

## Verificacion Rapida

```powershell
foreach ($p in 5174,8765,8808,3000) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  Write-Output "puerto $p : $(if ($c) {'ESCUCHANDO'} else {'caido'})"
}
Get-Process -Name Code, start-talk -ErrorAction SilentlyContinue |
  Select-Object Name, Id, StartTime
```

Canal MCP (solo si el tunel esta levantado):

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:8808/health
Invoke-RestMethod https://mcp.luminaopenia.com/health
```

## Tests de Start Talk

```powershell
Set-Location "C:\Lumina Code\continue-upstream\core"
npx vitest run startTalk        # 149 tests
npx tsc -p ./ --noEmit

Set-Location "C:\Lumina Code\continue-upstream\gui"
npx vitest run src/components/startTalk   # 45 tests
npx tsc --noEmit -p tsconfig.json
```

Y antes de compilar el orbe, la validación del propio proyecto:

```powershell
Set-Location "C:\Lumina Code\Start-talk"
npm run check
```
