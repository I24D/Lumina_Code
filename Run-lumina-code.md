# Ejecutar Lumina Code en modo desarrollador

Ultima actualizacion: 2026-07-22.

Este documento es la fuente de verdad para abrir Lumina Code sin mezclarlo con
otros proyectos. El flujo actual conserva solo:

- Lumina Code dentro de un VS Code Extension Development Host aislado.
- Start Talk como orbe nativo Windows lanzado desde Lumina Code.
- Windows Bridge (`:8765`) y Lumina MCP Gateway (`:8808`) como runtime de
  apoyo, mas Lumina Core (`:3000`) y Model Router cuando se necesiten.

Los proyectos externos no se arrancan, empaquetan ni supervisan desde Lumina
Code.

## Comando Oficial

Abrir PowerShell y ejecutar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\I24D_WhatsApp\Lumina-Code\ABRIR_LUMINA_CODE_DEV.ps1
```

El launcher hace tres cosas:

1. Arranca la UI dev de Lumina Code en `127.0.0.1:5174` si no esta viva.
2. Compila la extension de VS Code.
3. Abre un VS Code Extension Development Host aislado.

## Start Talk

Start Talk se abre desde Lumina Code con el comando:

```text
Lumina Code: Start Talk (orbe de escritorio)
```

Ese comando es importante porque crea el `OrbBridgeServer` y lanza
`Start-talk\src-tauri\target\release\start-talk.exe` con `LUMINA_ORB_BRIDGE`.
Si se ejecuta el `.exe` a mano, la ventana nativa puede abrir pero no responder
porque no tiene puente con Lumina Code.

## Puente con la app de Claude (canal MCP)

La app de Claude habla con Lumina Code a traves de un conector MCP remoto
(`https://mcp.luminaopenia.com/mcp`). Para que ese canal responda hacen falta
tres piezas vivas:

1. **Windows Bridge** (`:8765`) — habilita `pc_*` y `whatsapp_respond`.
   Arranque manual:
   `node --experimental-strip-types src\server.ts` en
   `Lumina_PC\apps\lumina-windows-bridge`.
2. **Lumina MCP Gateway** (`:8808`) — es el origen del tunel
   `mcp.luminaopenia.com`; si esta caido el conector da 502 y se desconecta.
   Arranque manual:
   `node --experimental-strip-types src\server.ts` en
   `Lumina_PC\apps\lumina-mcp-gateway`.
   (Cada uno auto-carga el `.env` raiz; no hay que inyectar variables.)
3. **La barra lateral de Lumina Code abierta** en el Dev Host. Al abrirla, la
   extension publica `~/.lumina/mcp-bridge.json`; sin eso `lumina_code_chat`
   responde `chat_bridge_unavailable` (aunque los demas tools ya funcionen).

`memory_recall` / `memory_save` requieren ademas Lumina Core en `:3000`.

El tunel `cloudflared` ya corre como servicio Windows 24/7, pero los dos node
de arriba NO son servicios: si reinicias el PC hay que relanzarlos.

## No Usar

- `setup.exe` durante desarrollo.
- Navegador para Start Talk.
- Ejecutar `Start-talk` con `npm run dev` para probar el orbe nativo.
- Arrancar proyectos externos desde este launcher.

## Verificacion Rapida

```powershell
Get-NetTCPConnection -LocalPort 5174 -ErrorAction SilentlyContinue
Get-Process -Name Code -ErrorAction SilentlyContinue
Get-Process -Name start-talk -ErrorAction SilentlyContinue
```

Canal MCP (app de Claude):

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:8808/health
Invoke-RestMethod https://mcp.luminaopenia.com/health
```
