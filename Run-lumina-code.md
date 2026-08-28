# Ejecutar Lumina Code en modo desarrollador

Ultima actualizacion: 2026-08-28.

Este documento es la fuente de verdad para volver a levantar el proyecto desde
cero (por ejemplo despues de apagar el PC). El flujo actual conserva solo:

- Lumina Code dentro de un VS Code Extension Development Host aislado.
- Start Talk como pestaña del navegador servida y abierta desde Lumina Code.
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

Start Talk se abre **desde el boton "Start talk" del chat** o desde la paleta de
comandos del Dev Host:

```text
Lumina Code: Start Talk
```

Ese comando arranca el `OrbBridgeServer` (HTTP + WebSocket en `127.0.0.1`,
puerto efimero + token de sesion), que sirve la MISMA gui de Lumina Code, y
abre el navegador en esa URL. La pagina inicial exige el token, asi que abrir
`http://127.0.0.1:<puerto>/` a mano devuelve 403.

`127.0.0.1` cuenta como contexto seguro en el navegador, asi que el microfono y
el AudioWorklet funcionan. La primera vez el navegador pedira permiso de
microfono para ese origen.

Requisito: la clave del proveedor de voz en el `.env` de la raiz.
`OPENAI_API_KEY` para la configuracion por defecto (`gpt-realtime-2.1`, voz
`marin`), o `GEMINI_API_KEY` si prefieres Gemini Live.

## Que hay que reconstruir segun lo que toques

Esto es lo que mas tiempo hace perder. El orbe ya no embebe nada: se sirve
`gui/dist` en caliente, asi que un cambio de interfaz se ve recargando la
pestaña.

| Tocaste | Reconstruir | Como se ve el cambio |
|---|---|---|
| `continue-upstream/core/**` | `npm run esbuild` en `extensions/vscode` | Recargar el Dev Host |
| `continue-upstream/extensions/vscode/**` | igual que arriba | Recargar el Dev Host |
| `continue-upstream/gui/**` (incluye la UI de Start Talk) | `npm run build` en `gui` | Recargar la pestaña del orbe |

### Reconstruir el orbe (cambios de GUI)

El orbe ya no es un ejecutable: la extension sirve `gui/dist` en 127.0.0.1 y lo
abre en el navegador. Un cambio de interfaz son dos pasos:

```powershell
Set-Location "C:\Lumina Code\continue-upstream\gui"
npm run build
# y recargar la pestaña del orbe (F5)
```

En desarrollo se sirve **siempre** `gui/dist`, no la copia empaquetada en
`extensions/vscode/gui` (que solo se refresca al generar el VSIX y suele estar
dias atrasada). Esa preferencia la decide `resolveOrbFrontendRoot` a partir del
modo de la extension.

El launcher ya reconstruye `gui/dist` solo si detecta fuentes mas nuevas, asi
que normalmente basta con abrirlo.

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
- Abrir la URL del orbe a mano sin el token: la sirve el comando, que es quien
  crea el puente de sesion.
- Arrancar proyectos externos desde este launcher.

## Verificacion Rapida

```powershell
foreach ($p in 5174,8765,8808,3000) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  Write-Output "puerto $p : $(if ($c) {'ESCUCHANDO'} else {'caido'})"
}
Get-Process -Name Code -ErrorAction SilentlyContinue |
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

Set-Location "C:\Lumina Code\continue-upstream\extensions\vscode"
npx vitest run src/extension/OrbBridgeServer   # 11 tests: token, rutas, puerto
```
