# Plan de Desarrollo: Start Talk para Lumina Code

## Objetivo

Redisenar Start Talk como una experiencia de voz nativa de Lumina Code dentro de VS Code.

Start Talk no debe sentirse como un modal ni como una ventana emergente. Debe sentirse como un modo vivo de Lumina: una interfaz voice-first, fluida, minimalista y conectada al runtime real del agente.

La referencia visual es Gemini Live en Android, pero la implementacion debe tener identidad propia de Lumina Code.

## Reglas Base

- No crear UI duplicada.
- Usar la UI actual en `continue-upstream/gui`.
- El backend de voz vive en `continue-upstream/core/startTalk`.
- Gemini Live es exclusivo de Start Talk.
- El LLM del chat normal sigue separado y funcionando como Continue/Lumina lo maneja.
- No reintroducir TTS viejo ni Web Speech API como camino principal.
- No implementar soluciones temporales que ensucien el proyecto.
- No crear carpetas de desarrollo descartables.
- Todo cambio debe compilar en core, gui y extension VS Code.
- Todo estado mostrado en la UI debe venir del runtime real, no inventarse en frontend.

> NOTA (2026-07-17): El estado real ya avanzo mas alla de este diseño original.
> Ver la seccion "ACTUALIZACION 2026-07-17" al final del documento para el estado
> implementado (orbe de escritorio Tauri), como corre Start Talk hoy, rutas de
> archivos, y el plan de fusion con `src/cuerpo`.

## Estado Actual

Start Talk ya responde con Gemini Live usando:

- Provider realtime: Gemini Live.
- Modelo verificado: `gemini-3.1-flash-live-preview`.
- API key desde `C:\I24D_WhatsApp\.env`.
- Captura de microfono desde core usando FFmpeg, para evitar el bloqueo de permisos de los VS Code Webviews.
- Audio de respuesta reproducido en el WebView.

El estado actual funciona, pero aun es una experiencia basica. Falta convertirlo en una experiencia de producto.

## Arquitectura Deseada

### Chat Mode

Estado normal de Lumina Code.

Debe mantener:

- Historial.
- Streaming.
- Tool calls.
- Terminal.
- Thinking.
- Imagenes.
- Archivos.
- MCP.
- Providers.
- Contexto del workspace.
- Entrada normal del chat.

En este modo, la barra inferior debe incluir acceso a Live sin romper el flujo normal.

### Live Mode

Al pulsar Start Talk o Live:

- No se abre un modal.
- No aparece una ventana rigida.
- El panel de Lumina entra en un modo live mediante una transicion suave.
- El chat queda detras, funcionando y registrando lo ocurrido.

Elementos principales:

- Esfera central de Lumina.
- Pregunta principal.
- Estado actual del agente.
- Transcripcion del usuario en tiempo real.
- Respuesta de Lumina en streaming.
- Barra inferior con controles de voz.

Estados visibles:

- Escuchando.
- Pensando.
- Hablando.
- Ejecutando.
- Leyendo archivos.
- Escribiendo codigo.
- Usando terminal.
- Llamando MCP.
- Esperando confirmacion.
- Completado.
- Error.

### Mini Orb

Al minimizar:

- Start Talk no se cierra.
- La sesion sigue viva.
- Aparece una esfera pequena flotante.
- Un clic vuelve a Live Mode.

La Mini Orb debe reflejar estado real:

- Escuchando.
- Pensando.
- Hablando.
- Ejecutando herramientas.
- Error.
- Completado.

## Componentes Propuestos

Ubicacion sugerida:

`continue-upstream/gui/src/components/startTalk/`

Componentes:

- `StartTalkProvider`
- `VoiceSessionManager`
- `LiveConversationOverlay`
- `OrbRenderer`
- `OrbAnimationEngine`
- `ConversationStateMachine`
- `VoiceControls`
- `VoiceTranscript`
- `ToolActivityPanel`
- `ProviderIndicator`
- `MiniOrb`
- `FloatingOverlay`
- `VoiceAudioVisualizer`
- `VoiceStatus`
- `TransitionManager`

La estructura puede ajustarse a los patrones existentes del repo, pero la separacion conceptual debe mantenerse:

- UI.
- Estado.
- Animaciones.
- Voz.
- Runtime.
- Tool calls.
- Sincronizacion con chat.

## Backend Propuesto

Ubicacion:

`continue-upstream/core/startTalk/`

Responsabilidades:

- Crear y cerrar sesiones Gemini Live.
- Leer configuracion exclusiva de Start Talk desde `.env`.
- Capturar audio del microfono desde core.
- Enviar PCM a Gemini Live.
- Recibir audio de Gemini.
- Emitir transcripciones.
- Emitir estados reales.
- Emitir errores claros.
- Preparar integracion futura con runtime/tool calls.

Eventos principales:

- `startTalk/connect`
- `startTalk/startCapture`
- `startTalk/stop`
- `startTalk/sendText`
- `startTalk/event`

Eventos de UI esperados:

- `status`
- `audio`
- `transcript`
- `interrupted`
- `error`
- `toolActivity`
- `agentState`

## Fases de Desarrollo

### Fase 1: Estabilizar Base Realtime

Objetivo: asegurar que Start Talk siempre conecta, escucha y responde.

Tareas:

- Confirmar modelo Live por defecto.
- Validar `.env` sin exponer claves.
- Manejar cierres de Gemini con errores claros.
- Mejorar lifecycle de sesion.
- Evitar estados falsos en UI.
- Registrar eventos minimos de sesion para debug.

Verificacion:

- Click en Start Talk.
- Gemini saluda.
- El microfono queda activo.
- Lumina escucha.
- Lumina responde con audio.
- Stop corta captura y sesion.

### Fase 2: Reemplazar Ventana Actual por Live Overlay

Objetivo: eliminar la sensacion de modal.

Tareas:

- Crear `LiveConversationOverlay`.
- Integrarlo en la UI actual.
- Mantener chat detras.
- Implementar transicion Chat Mode a Live Mode.
- Mantener cierre limpio a Chat Mode.

Verificacion:

- No aparece ventana flotante rigida.
- El panel cambia fluidamente.
- El chat no pierde estado.

### Fase 3: Orb Renderer

Objetivo: crear la esfera viva de Lumina.

Estados visuales:

- Idle: respiracion lenta.
- Listening: pulso con volumen de microfono.
- Thinking: rotacion suave y ondas internas.
- Executing: destellos discretos.
- Speaking: vibracion sincronizada con audio.
- Error: estado visual sobrio.

Requisitos:

- 60 FPS.
- GPU-friendly CSS.
- `requestAnimationFrame` donde aplique.
- Sin renders innecesarios.
- Preparado para reemplazo futuro por avatar 2D, Live2D, 3D o MetaHuman.

### Fase 4: Transcripcion y Streaming Visual

Objetivo: mostrar conversacion viva sin esperar respuesta completa.

Tareas:

- Transcripcion del usuario en tiempo real.
- Respuesta de Lumina palabra por palabra.
- Estados del agente bajo la esfera.
- Manejo visual de interrupciones.

### Fase 5: Mini Orb

Objetivo: permitir minimizar sin cerrar.

Tareas:

- Crear `MiniOrb`.
- Mantener sesion activa.
- Reflejar estados reales.
- Restaurar Live Mode con un clic.
- Cerrar sesion solo con accion explicita.

### Fase 6: Tool Activity Panel

Objetivo: mostrar trabajo real de Lumina sin saturar.

Tarjetas discretas:

- Terminal.
- Workspace.
- MCP.
- Browser.
- Editor.
- Git.
- Docker.
- Filesystem.
- Memory.

Cada tarjeta debe aparecer solo cuando el runtime reporte actividad real.

### Fase 7: Sincronizacion con Chat e Historial

Objetivo: que Start Talk y el chat no sean mundos separados.

Tareas:

- Registrar transcripcion del usuario en el historial.
- Registrar respuesta de Lumina.
- Registrar tool calls.
- Registrar errores.
- Mantener streaming y logs detras.

Al cerrar Start Talk, el chat debe mostrar exactamente lo ocurrido.

### Fase 8: Controles Inferiores

Inspirados en Gemini Live, adaptados a Lumina:

- Camara.
- Compartir pantalla.
- Boton principal Live.
- Microfono.
- Cerrar.

Primera version:

- Microfono.
- Cerrar.
- Minimizar.
- Estado visual.

Camara y compartir pantalla deben quedar preparados arquitectonicamente, pero no activarse hasta que se disene su backend y permisos.

## Riesgos

- VS Code WebView bloquea `getUserMedia`; la captura debe seguir en core.
- FFmpeg es dependencia externa; se debe manejar ausencia con error claro.
- Gemini Live puede cambiar modelos disponibles.
- Hay que evitar mezclar Gemini Live con providers normales del chat.
- Las animaciones no deben degradar el rendimiento del panel.
- No se debe romper Continue nativo.

## Criterios de Aceptacion

- Start Talk responde al primer click.
- Gemini Live no afecta el LLM del chat normal.
- La UI no parece modal.
- El chat sigue funcionando detras.
- La sesion puede minimizarse a Mini Orb.
- La sesion puede cerrarse sin procesos colgados.
- Los estados visibles reflejan el runtime real.
- Core, gui y extension compilan.
- No hay carpetas duplicadas ni archivos temporales.
- No hay mojibake en archivos creados.

## Comandos de Verificacion

Desde `C:\I24D_WhatsApp\Lumina-Code\continue-upstream`:

```powershell
cd core
npm run tsc:check
```

```powershell
cd gui
npm run build
```

```powershell
cd extensions/vscode
npm run esbuild
```

Despues de compilar GUI:

```powershell
Remove-Item -Recurse -Force .\extensions\vscode\gui
Copy-Item -Recurse .\gui\dist .\extensions\vscode\gui
```

## Decision

El rediseno es viable.

La implementacion debe hacerse por fases, empezando por estabilizar la arquitectura actual y luego reemplazar la ventana por un Live Overlay real. El objetivo no es copiar Gemini Live, sino crear una experiencia de voz propia de Lumina Code, profesional, viva y extensible.

---

## ACTUALIZACION 2026-07-17

Referencia viva para Claude y Codex. Documenta lo que YA esta implementado
(orbe de escritorio), COMO corre Start Talk hoy end-to-end, todas las rutas de
archivos tocados/creados, y el plan de fusion con `src/cuerpo`.

Todas las rutas son relativas a `C:\I24D_WhatsApp` salvo que se indique.

## 1. Que se construyo: orbe de escritorio (Tauri) que reutiliza la MISMA UI

Objetivo cumplido: al pulsar "Start talk" en VS Code se abre una ventana
flotante encima del escritorio de Windows (fuera de VS Code, movible a otro
monitor) que muestra SOLO el overlay de Start Talk (no todo el chat de Lumina
Code), usando la MISMA UI existente (`LiveConversationOverlay`), NO una nueva.
La delegacion voz -> agente completo de Lumina Code se conserva intacta.

Regla clave: NO se duplico la UI. El orbe carga el bundle real de `gui` dentro
de una webview Tauri, y un shim `vscode -> WebSocket` hace que el `gui` corra
sin cambios fuera de VS Code.

### 1.1 App Tauri (nueva carpeta de desarrollo)

Raiz: `Lumina-Code/Start-talk/`

- `Start-talk/src-tauri/src/lib.rs`
  - Crea la ventana "main" con `WebviewWindowBuilder`, frameless
    (`decorations(false)`), `transparent(true)`, `always_on_top(true)`,
    `skip_taskbar(true)`, `center()`, `inner_size(420x620)`.
  - `initialization_script` inyecta:
    `window.__LUMINA_BRIDGE_URL__ = "<ws url>"` y
    `window.luminaOrbAutostart = true`.
- `Start-talk/src-tauri/tauri.conf.json`
  - `build.frontendDist = "../orb-frontend"` (carga el bundle ensamblado).
  - `app.withGlobalTauri = true`, `app.windows = []`, `security.csp = null`.
  - identifier `com.lumina.starttalk`.
- `Start-talk/src-tauri/capabilities/default.json`
  - Permisos de ventana: start-dragging, set-always-on-top, set-fullscreen,
    set-position, set-size, minimize, hide, show, close + opener:default.
- `Start-talk/orb-frontend/index.html` (SHIM, pieza central)
  - `#orb-drag`: franja de arrastre `data-tauri-drag-region`.
  - `#orb-diag`: panel de diagnostico en pantalla (se autodestruye cuando
    monta `#root`).
  - Shim `vscode -> WebSocket`: lee `window.__LUMINA_BRIDGE_URL__`, abre WS,
    define `window.vscode = { postMessage, getState, setState }`,
    `window.acquireVsCodeApi`, y re-emite los mensajes del WS como
    `window.dispatchEvent(new MessageEvent("message", { data: msg }))`.
  - Globals que el `gui` espera (localStorage `ide=vscode`, `window.ide`,
    `windowId`, tema, `workspacePaths`, etc.). `body` transparente.
  - Carga `/assets/index.css` y `/assets/index.js` (el bundle real de `gui`).
- `Start-talk/orb-frontend/{assets,fonts,logos,lumina-icon.png,lumina-working.png}`
  - Se ENSAMBLAN copiando desde `continue-upstream/gui/dist/...`.
  - IMPORTANTE: borrar los directorios destino ANTES de copiar, o
    PowerShell anida (`assets/assets/...`) y el exe embebe el bundle viejo.
- Exe compilado (Rust):
  `Start-talk/src-tauri/target/release/start-talk.exe`
  (o `.../debug/start-talk.exe` en dev).
- NOTA: `Start-talk/src/` (App.tsx, main.tsx, index.html) son el scaffold por
  defecto de Tauri y estan SIN USO (Tauri carga `orb-frontend`, no `src/`).
  No revertir ni borrar.

### 1.2 Extension VS Code (host que lanza el orbe y hace de puente)

- `continue-upstream/extensions/vscode/src/extension/OrbBridgeServer.ts` (NUEVO)
  - `WebSocketServer` en `{ host: 127.0.0.1, port: 0 }` (efimero) + token
    (`crypto.randomBytes(16)`).
  - `start()` devuelve `{ port, token }`. En cada conexion valida el token de
    la query, registra un `sink` via `webviewProtocol.addExternalSink`, y
    reenvia lo entrante con `webviewProtocol.handleExternalMessage`.
- `continue-upstream/extensions/vscode/src/extension/startTalkOrb.ts` (NUEVO)
  - `launchStartTalkOrb(context, webviewProtocol)`: resuelve el exe en
    `Start-talk/src-tauri/target/{release,debug}/start-talk.exe`, arranca el
    bridge y hace spawn del exe con
    `env.LUMINA_ORB_BRIDGE = ws://127.0.0.1:<port>/?token=<token>`.
  - `disposeStartTalkOrb()`.
- `continue-upstream/extensions/vscode/src/webviewProtocol.ts` (MODIFICADO,
  multi-surface)
  - `export type ExternalWebviewSink = (msg: Message) => void`.
  - `send()` ahora emite al webview del sidebar Y a todos los `externalSinks`
    (clientes del orbe). Se extrajo `handleIncomingMessage(msg, respond)` y se
    anadieron `addExternalSink(sink)` y `handleExternalMessage(msg, respond)`.
- `continue-upstream/extensions/vscode/src/commands.ts` (MODIFICADO)
  - Comando `"lumina.startTalkOrb"` -> `launchStartTalkOrb(extensionContext,
    sidebar.webviewProtocol)`.
- `continue-upstream/extensions/vscode/package.json` (MODIFICADO)
  - Contribucion del comando "Start Talk (orbe de escritorio)".
- `continue-upstream/extensions/vscode/src/extension/VsCodeMessenger.ts`
  (MODIFICADO)
  - Handler `this.onWebview("startTalk/launchOrb", () =>
    vscode.commands.executeCommand("lumina.startTalkOrb"))`.
- `continue-upstream/extensions/vscode/src/activation/activate.ts` (FIX)
  - Se corrigio un bug TDZ pre-existente: `startLuminaDelegationListener` se
    llamaba antes de declarar `const vscodeExtension`. Reordenado.

### 1.3 Protocolo core

- `continue-upstream/core/protocol/ideWebview.ts` (MODIFICADO)
  - Se agrego el tipo `"startTalk/launchOrb": [undefined, void]` en
    `ToIdeFromWebviewProtocol`.

### 1.4 GUI (React) — boton, modo orbe y fullscreen

- `continue-upstream/gui/src/components/startTalk/StartTalkButton.tsx`
  (REESCRITO)
  - Al hacer click: `ideMessenger.post("startTalk/launchOrb", undefined)`
    (abre el orbe de escritorio, ya NO el overlay dentro del panel).
- `continue-upstream/gui/src/App.tsx` (MODIFICADO — modo orbe-only)
  - Si `window.luminaOrbAutostart` es true, renderiza `OrbApp()`, que monta
    SOLO `<LiveConversationOverlay isOpen onClose={closeOrbWindow} />` (con sus
    providers) + `<ParallelListeners />`. NO renderiza el chat completo.
  - `closeOrbWindow()` cierra la ventana Tauri
    (`window.__TAURI__.window.getCurrentWindow().close()`).
- `continue-upstream/gui/src/components/startTalk/LiveConversationOverlay.tsx`
  (MODIFICADO — fullscreen del orbe)
  - `PanelShell` acepta `$fullscreen` (ocupa 100vw x 100vh, sin bordes ni
    sombra).
  - Boton expandir (el de antes de la X): en modo orbe llama
    `toggleOrbFullscreen()` ->
    `window.__TAURI__.window.getCurrentWindow().setFullscreen(next)`; fuera del
    orbe mantiene el modo `expanded/compact` clasico.

## 2. Como corre Start Talk AHORA (flujo runtime end-to-end)

Hay DOS "cerebros/cuerpos" separados; no confundir:

- Lumina Code = `continue-upstream/` (extension VS Code: `core` + `gui` +
  Start Talk). Corre en el extension host. Es el agente que ejecuta.
- Backend I24D = `src/server.ts` + `src/cerebro` (LUMINA, el cerebro) +
  `src/cuerpo` (el cuerpo de ejecucion). Es un servidor Node aparte en
  `http://127.0.0.1:3000`.

Secuencia al pulsar "Start talk":

1. `gui` StartTalkButton -> `ideMessenger.post("startTalk/launchOrb")`.
2. `VsCodeMessenger` recibe -> `vscode.commands.executeCommand("lumina.startTalkOrb")`.
3. `commands.ts` -> `launchStartTalkOrb(context, sidebar.webviewProtocol)`.
4. `startTalkOrb.ts` arranca `OrbBridgeServer` (WS 127.0.0.1:efimero + token) y
   hace spawn de `start-talk.exe` con `LUMINA_ORB_BRIDGE=ws://.../?token=...`.
5. Tauri `lib.rs` inyecta `__LUMINA_BRIDGE_URL__` + `luminaOrbAutostart=true` y
   carga `orb-frontend/index.html`.
6. El shim de `index.html` conecta el WS al bridge, falsea `window.vscode`, y
   carga el bundle real de `gui` (`assets/index.js`).
7. `gui` App.tsx ve `luminaOrbAutostart` -> renderiza `OrbApp` (solo
   `LiveConversationOverlay`).
8. `ParallelListeners`/`initialLoadConfig` carga config
   (`config/getSerializedProfileInfo`) por el WS.
9. Voz: `core/startTalk/StartTalkManager.ts` abre sesion Gemini Live; el
   microfono se captura en core con FFmpeg (`FfmpegMicrophoneCapture.ts`) para
   esquivar el bloqueo de `getUserMedia` del webview; el audio de respuesta se
   reproduce en la webview del orbe.
10. Los eventos `startTalk/event` viajan del core al orbe porque estan en
    `CORE_TO_WEBVIEW_PASS_THROUGH` (broadcast a los external sinks del bridge).
11. Delegacion: Gemini llama la funcion `delegate_to_lumina_code`
    (`StartTalkManager.ts`), lo que dispara en el `gui` el `streamResponseThunk`
    -> agente COMPLETO de Lumina Code (tools, MCP, terminal, workspace,
    `lumina_windows_bridge`) por el WS -> el resultado vuelve y se lee en voz.

Modelo por defecto verificado: `gemini-3.1-flash-live-preview` (audio nativo:
`2.5-native-audio`). Grounding nativo de Google (`googleSearch`) activo cuando
el modelo lo soporta (ver `SEARCH_INCOMPATIBLE_MODELS` en StartTalkManager).

### 2.1 Comandos para correr / compilar

Desde `continue-upstream`:

```powershell
cd core; npm run tsc:check
cd ..\gui; npm run build
cd ..\extensions\vscode; npm run esbuild
```

Reensamblar el orbe tras compilar `gui` (borrar destino ANTES de copiar):

```powershell
$fe = "C:\I24D_WhatsApp\Lumina-Code\Start-talk\orb-frontend"
foreach ($d in "assets","fonts","logos") {
  if (Test-Path "$fe\$d") { Remove-Item -Recurse -Force "$fe\$d" }
  Copy-Item -Recurse "C:\I24D_WhatsApp\Lumina-Code\continue-upstream\gui\dist\$d" "$fe\$d"
}
```

Compilar el exe Tauri:

```powershell
cd C:\I24D_WhatsApp\Lumina-Code\Start-talk\src-tauri
cargo build            # debug (lo que lanza el launcher si no hay release)
# o: cargo build --release
```

> IMPORTANTE: Tauri EMBEBE `orb-frontend` dentro del `.exe` al compilar
> (`frontendDist`, sin dev-server). Reensamblar `orb-frontend/` NO actualiza el
> orbe en ejecucion: hay que **recompilar el exe con `cargo build`** y volver a
> lanzar (clic en Start talk). El launcher usa `release/start-talk.exe` si existe,
> si no `debug/start-talk.exe`. Si el orbe esta abierto, cerrarlo antes de
> compilar (el exe queda bloqueado).

Verificaciones utiles:

- `orb-frontend/assets/index.js` debe CONTENER `luminaOrbAutostart`.
- `Test-Path orb-frontend/assets/assets` debe ser `False` (no anidado).

### 2.2 Nota de entorno (dev host vs VSIX instalado)

El [Extension Development Host] debe correr la extension de DESARROLLO, no la
VSIX instalada. Si gana la instalada, se marca obsoleta en
`C:\Users\dal_n\.vscode\extensions\.obsolete` (entrada
`"luminacode.lumina-code-<version>":true`) o se cierran todas las ventanas de
VS Code para poder borrar la carpeta instalada. El comando "Start Talk (orbe de
escritorio)" solo existe en la version de desarrollo: es el test rapido de que
corre la correcta.

## 3. Fusion con `src/cuerpo` (PLAN — pendiente de codificar)

Objetivo: que Start Talk (voz) gane las capacidades del backend `src/cuerpo`
(toolOrchestrator completo, warehouses/memoria, imagen/video/TTS del backend)
SIN que Gemini pierda su poder nativo de Google y SIN romper Lumina Code.

Principio de diseno (critico):

- NO se agregan nuevas `functionDeclarations` a Gemini (eso arriesga desactivar
  `googleSearch` grounding en algunos modelos Live -> cierre 1011).
  `buildLiveTools()` en `StartTalkManager.ts` NO se toca.
- Las capacidades de `cuerpo` se agregan al ARSENAL DEL AGENTE de Lumina Code,
  al que la voz ya llega por `delegate_to_lumina_code`. Gemini "evoluciona"
  (cuando delega, el agente tiene todo el cuerpo detras) pero conserva 100% lo
  nativo (grounding, audio nativo, vision por webcam, barge-in).
- `cuerpo` sigue siendo proceso servidor aparte; solo se le habla por HTTP con
  el puente que YA existe. No se importa `cuerpo` en el extension host.

Plomeria que YA existe (no reconstruir):

- Puente Lumina Code -> backend:
  `continue-upstream/core/luminaBridge/runtimeClient.ts`
  (base `http://127.0.0.1:3000`; acciones: chat, health, memory_recent,
  memory_search, harness_task).
- Endpoint generico a TODO el toolOrchestrator:
  `POST /lumina/cuerpo/tool` en `src/routes/admin.routes.ts` (body
  `{ tool, args, userId }` -> `executeTool` -> `{ ok, output, result }`).
- Tambien existe `POST /lumina/devcore/review`.
- Catalogo de tools de cuerpo: `buildAvailableTools()` y `executeTool()` en
  `src/cuerpo/tools/toolOrchestrator.ts` (~24 tools: `pc_*`, `buscar_en_internet`,
  `investigacion_profunda`, `generar_imagen`, `generar_video`,
  `guardar_conocimiento`, etc.).
- Auth: `isAuthorizedLuminaAdmin` en `admin.routes.ts` (si `config.adminToken`
  esta vacio el endpoint es abierto en local; si esta seteado exige
  `Bearer <adminToken>`). No debilitar; propagar el bearer.
- Patron de tools del agente:
  `continue-upstream/core/tools/definitions/` (schemas) +
  `continue-upstream/core/tools/implementations/` (ejecutores) +
  `continue-upstream/core/tools/callTool.ts` (dispatch). Ejemplos ya existentes:
  `luminaWindowsBridge`, `luminaRuntime`, `luminaImageGen`, `luminaVideoGen`.

Fases del plan:

- Fase 0 (backend, bajo riesgo): agregar `GET /lumina/cuerpo/tools` en
  `admin.routes.ts` que devuelva `buildAvailableTools()` (catalogo). Nada mas se
  toca en `cuerpo`.
- Fase 1 (core, corazon): nueva tool puente `cuerpo_execute`:
  - `core/tools/definitions/cuerpoTool.ts` (schema `{ tool, args }`),
  - `core/tools/implementations/cuerpoTool.ts` (llama `runtimeClient` ->
    `POST /lumina/cuerpo/tool`),
  - accion `"cuerpo_tool"` en `runtimeClient.ts`,
  - registrar en `core/tools/definitions/index.ts` y `core/tools/callTool.ts`.
- Fase 2 (memoria): usar/confirmar `memory_recent`/`memory_search` (warehouses)
  como tool del agente, o cubrir recall/`guardar_conocimiento` via
  `cuerpo_execute`.
- Fase 3 (imagen/video/TTS): DECISION pendiente — hay duplicidad
  (`luminaImageGen`/`luminaVideoGen` en core por keys directas VS
  `generar_imagen`/`generar_video`/`tts` en cuerpo). Propuesta: canalizar por
  cuerpo como fuente unica, dejando lo actual como fallback.
- Fase 4 (prompt): ampliar SOLO el texto del system prompt de delegacion en
  `StartTalkManager.ts` (lineas ~44-47) para que Gemini sepa que puede delegar
  investigacion profunda, imagen/video, memoria y tools del sistema del cuerpo.
  Cero cambios en tools nativas.
- Fase 5 (build + humo): `tsc` core + esbuild extension + reensamblar orbe;
  probar voz -> delega -> `cuerpo_execute` -> responde; confirmar que el
  grounding nativo de Google sigue vivo en la misma sesion.

Lo que NO se toca: `buildLiveTools`, pump de webcam, `VoiceActivityGate`, el
orbe/Tauri, y el runtime de `cuerpo` (solo se le agrega 1 endpoint GET).

## 4. Memoria persistente en Start Talk (IMPLEMENTADO)

Objetivo: que la voz recuerde al usuario entre sesiones, accediendo a la memoria
del backend (pgvector sobre Supabase) SIN sacar el service_role al cliente y SIN
tocar las tools nativas de Gemini.

Decisiones cerradas:

- Acceso a Supabase = via backend API (`/api/memory/*`), NUNCA cliente directo.
  El service_role no sale del servidor.
- Embeddings = OpenAI `text-embedding-3-small` (1536 dims). Coincide con la
  columna pgvector actual (cero migracion). Ollama Cloud NO sirve embeddings
  (probado en vivo: solo modelos de generacion), se descarta para memoria.
- Auth = `Authorization: Bearer <I24D_ADMIN_TOKEN>`. El backend valida con
  `env.adminToken = readString("I24D_ADMIN_TOKEN")` y el cliente lee la misma
  var del `.env` raiz -> alineados.

Archivos:

- `continue-upstream/core/startTalk/voiceMemory.ts` (NUEVO)
  - `loadVoiceMemoryBlock(userId?)`: GET `/api/memory/recent` + `/api/memory/proactive`,
    arma un bloque (identidad + brief proactivo + memorias durables + reciente)
    para el system prompt. Best-effort: si el backend no responde, devuelve "".
  - `learnFromVoiceTranscript(transcript, userId?)`: POST `/api/memory/learn`
    con `{ userId, transcript:[{role,text}], channel:"voice" }`.
  - `resolveVoiceUserId()`: userId canonico (`LUMINA_CANONICAL_USER_ID`).
  - Reusa `resolveLuminaCoreUrl`/`resolveLuminaCanonicalUserId` (runtimeClient)
    y `readLuminaEnv` (luminaEnv). Timeout 6s, todo degrada en silencio.
- `continue-upstream/core/startTalk/StartTalkManager.ts` (MODIFICADO)
  - `SessionState` gana `memoryUserId`, `memoryBlock`, `transcript`.
  - `connect()`: resuelve userId, precarga `memoryBlock` (await best-effort)
    ANTES de abrir la sesion; se cachea para no re-consultar en cada reconnect.
  - `openLiveSession()`: el `systemInstruction` = persona + `\n\n` + memoryBlock
    (si existe). `buildLiveTools`/googleSearch INTACTOS.
  - `handleServerMessage()`: acumula la transcripcion FINAL (user + assistant)
    en `state.transcript` via `appendTranscript` (coalesce por rol, cap 60).
  - `stop()`: fire-and-forget `learnFromVoiceTranscript(state.transcript,...)`.

Estado build: `core` tsc:check 0 errores; extension esbuild OK. (gui/orbe no
cambian: la memoria corre en core dentro del extension host.)

Verificacion en vivo (2026-07-17, backend arrancado a mano): `/api/memory/recent`
200 (identidad "Dal" + durables), `/api/memory/proactive` 200 (brief real),
`/api/memory/learn` 200. Camino M1/M2/M3 confirmado. Prueba de voz: hablar algo
memorable, cerrar (dispara learn), reabrir -> Gemini deberia recordarlo;
confirmar que el grounding nativo de Google sigue vivo.

## 5. Ciclo de vida del backend atado a Lumina Code (IMPLEMENTADO)

Objetivo: el backend I24D (`:3000`) se ENCIENDE al activar la extension y se
APAGA al cerrar VS Code / recargar la ventana.

Archivos:

- `continue-upstream/extensions/vscode/src/extension/backendLifecycle.ts` (NUEVO)
  - `startI24dBackend(context)`: si `:3000` no responde a `/health`, arranca
    `npm start` (= `tsx src/server.ts`) desde la raiz del repo. Best-effort,
    fire-and-forget, no bloquea ni rompe la activacion. Idempotente: si el
    backend YA responde (a mano u otra ventana), NO lanza duplicado y NO se
    considera su dueno. Registra un disposable en `context.subscriptions`.
  - `stopI24dBackend()`: si esta extension lo arranco, mata el arbol
    (`taskkill /PID <pid> /T /F` en Windows). Sincrono y best-effort.
  - Raiz del repo: `I24D_BACKEND_DIR` -> subir 4 desde extensionPath ->
    `C:\I24D_WhatsApp` (valida que exista package.json + src/server.ts).
  - Opt-out: `LUMINA_BACKEND_AUTOSTART=false|0|off`. Puerto: `LUMINA_BACKEND_PORT`
    o `PORT` (default 3000).
- `continue-upstream/extensions/vscode/src/activation/activate.ts` (MODIFICADO)
  - `void startI24dBackend(context)` tras `startLuminaRuntimeHeartbeat`.
- `continue-upstream/extensions/vscode/src/extension.ts` (MODIFICADO)
  - `deactivate()` llama `stopI24dBackend()`.

Nota multi-ventana: la primera ventana es la dueña; al cerrarla el backend se
apaga aunque queden otras. Para uso dev-only de un usuario es lo esperado.

Estado build: extension tsc --noEmit 0 errores; esbuild OK.

Como probarlo: recargar el Dev Host (Developer: Reload Window) -> en los logs
`[Lumina backend] arrancando backend …` y luego `backend listo en :3000`.
Cerrar la ventana -> `apagando backend (pid …)`.

## 6. Capacidades avanzadas de Start Talk (IMPLEMENTADO)

Desarrollo del roadmap avanzado. Todo el codigo nuevo esta en ingles, es TS puro
(sin JS), no usa modelos locales, degrada con gracia y NO toca el camino nativo
de Gemini (`buildLiveTools`/grounding/audio nativo intactos). 25 tests unitarios
en verde; core tsc 0, gui build OK, extension tsc 0 + esbuild OK.

### 6.1 Modo interprete — traduccion en tiempo real (todas las lenguas)

- Tipos: `StartTalkMode` ("assistant" | "interpreter"), `StartTalkTranslationConfig`
  ({ source?, target, bidirectional? }) en `core/startTalk/types.ts`.
- `StartTalkManager.connect()` acepta `mode` + `translation`. En interprete:
  apaga tools/grounding/memoria/saludo, fija el idioma de salida al destino
  (unidireccional) y usa `buildInterpreterInstruction()` (solo traduce, nunca
  responde). Bidireccional: traduce source↔target por locucion.
- Plomeria: `startTalk/connect` (protocolo), `core.ts` handler, hook
  `useStartTalkAudio({ translation })`, y UI en `LiveConversationOverlay`
  (checkbox "Interpreter" + selector de 12 idiomas). Cambiar de idioma reinicia
  la sesion (config-key incluye la traduccion).

### 6.2 Procesamiento de sonido (DSP) — `core/startTalk/AudioProcessor.ts`

- Cadena real entre el microfono y el VAD: high-pass/DC-block (1er orden) →
  supresion de ruido espectral (STFT radix-2 FFT propia, ventana raiz-Hann WOLA
  50% solape, resta espectral adaptativa con piso de ganancia) → AGC (RMS objetivo
  con limitador, attack rapido/release lento).
- Insertado en `startCapture` (`state.audioProcessor.process(chunk)` antes del
  gate). Opt-out: `START_TALK_AUDIO_DSP=false`.
- Tests: `AudioProcessor.vitest.ts` (FFT round-trip, silencio, DC, AGC, reduccion
  de ruido blanco, tamaños arbitrarios).

### 6.3 Diarizacion + biometria de voz — `core/startTalk/voiceBiometrics.ts`

- Cliente a `/api/biometric/voice/identify` (backend F3). Buffer del audio del
  turno del usuario (via callbacks del gate), al cerrar el turno se envia como
  WAV base64 (encoder `encodeWav` puro en TS) y se emite evento `speaker`
  (identityId/name/score). Best-effort; opt-in `START_TALK_BIOMETRICS=true`
  (requiere el bridge Python Resemblyzer del backend). Tests del encoder WAV.
- La UI muestra `🎙 «nombre»` sobre la transcripcion cuando hay match.

### 6.4 Captura multiplataforma + dispositivos — `FfmpegMicrophoneCapture.ts`

- `listAudioInputDevices()` por plataforma: Windows dshow, macOS avfoundation
  (por indice), Linux pulse (`pactl`). `buildCaptureInput()` arma formato+input.
- Manager: `listAudioDevices()` y `switchAudioDevice()` (hot-swap sin cortar la
  sesion Live). Protocolo `startTalk/listAudioDevices` + `startTalk/switchAudioDevice`.

### 6.5 Nivel de micro, mute/push-to-talk, estilo de voz, export de transcripcion

- Evento `level` (RMS normalizado, throttled ~12fps) → orbe reactivo al audio
  real (`micLevel` en la UI, escala del orbe).
- `setMuted` (push-to-talk): dropea el mic mientras muteado; boton en la UI.
- `voiceStyle` en connect → linea de estilo en el system prompt (modo asistente).
- `getTranscript` → export del transcript acumulado (`exportTranscript` en el hook).
- Protocolo: `startTalk/setMuted`, `startTalk/getTranscript`.

### 6.6 Deteccion de eventos de sonido — `core/startTalk/SoundEventDetector.ts`

- Clasificador model-free (FFT: RMS, ZCR, flatness espectral, centroide, crest):
  silence / speech / tonal / impulsive / broadband. Emite evento `soundEvent`
  (debounced) para sonidos no verbales. Opt-in `START_TALK_SOUND_EVENTS=true`.
  Tests: `SoundEventDetector.vitest.ts` (5).

### 6.7 Abstraccion de proveedor — `core/startTalk/VoiceProvider.ts`

- Seam de extension para un proveedor de fallback (`resolveVoiceProvider`,
  `START_TALK_PROVIDER`). Hoy solo `gemini-live` (StartTalkManager). Documenta
  el contrato que debe cumplir un segundo backend (STT→LLM→TTS streaming). No se
  incluye un proveedor hueco a proposito.

### 6.8 Pendiente / decisiones

- **Wake word**: entregado push-to-talk (mute). El wake word real ("Lumina…")
  necesita un modelo on-device (Porcupine/openWakeWord) que choca con la regla
  dura "sin modelos locales". Queda diferido hasta definir un wake word en la
  nube o una excepcion explicita.
- **AEC real (NLMS)**: el gate duplex-aware + supresion de ruido cubren la mayor
  parte; un cancelador de eco adaptativo con la referencia de reproduccion queda
  como siguiente iteracion (requiere alineacion de retardo y pruebas con audio
  real).
- **ElevenLabs / voces multiples**: `voiceName` y `voiceStyle` ya se pasan por
  sesion; usar ElevenLabs como TTS alterno implica bypassar el audio nativo
  duplex de Gemini (trade-off), documentado como opcion futura.

Flags de entorno nuevos (todos opcionales):
`START_TALK_AUDIO_DSP` (default on), `START_TALK_BIOMETRICS` (default off),
`START_TALK_SOUND_EVENTS` (default off), `START_TALK_PROVIDER` (default
gemini-live), `START_TALK_AUDIO_DEVICE` (dispositivo por defecto).

Archivos nuevos: `AudioProcessor.ts`(+vitest), `SoundEventDetector.ts`(+vitest),
`voiceBiometrics.ts`(+vitest), `VoiceProvider.ts`. Modificados: `types.ts`,
`index.ts`, `StartTalkManager.ts`, `FfmpegMicrophoneCapture.ts`,
`core/core.ts`, `core/protocol/core.ts`, `core/protocol/passThrough.ts`,
`gui/.../useStartTalkAudio.ts`, `gui/.../LiveConversationOverlay.tsx`.

### 6.9 UI 100% cableada (backend ↔ frontend) — `gui/.../StartTalkControls.tsx`

Todas las capacidades del motor/hook estan surfaceadas en el orbe (nada queda
"solo en el motor"):

- **Interprete**: checkbox on/off, selector de idioma **origen** (en bidireccional),
  **destino**, y toggle **Two-way** (bidireccional). Cambiar cualquiera reinicia
  la sesion limpio (config-key).
- **Estilo de voz**: input + chips de presets (modo asistente).
- **Dispositivo de microfono**: `<select>` poblado con `listAudioDevices()` al
  abrir + boton Refresh; al elegir uno llama `switchAudioDevice()` (hot-swap).
- **Export de transcripcion**: boton que llama `getTranscript()` y copia al
  portapapeles (estados Copied ✓ / No transcript).
- **Eventos de sonido**: badge "heard: …" cuando el detector emite (opt-in).
- **Mute/push-to-talk**: boton de altavoz en los controles.
- **Orbe reactivo** al nivel real del micro; **🎙 «nombre»** del hablante
  identificado sobre la transcripcion.

El hook `useStartTalkAudio` expone: `micLevel`, `speaker`, `isMuted`,
`toggleMute`, `lastSoundEvent`, `listAudioDevices`, `switchAudioDevice`,
`exportTranscript`, y acepta `translation` + `voiceStyle`. Todo pasa por el
protocolo webview↔core (mensajes `startTalk/*` en passThrough) ↔ StartTalkManager
↔ backend I24D (`/api/memory/*`, `/api/biometric/*`).

Estado build final: core tsc 0 · gui `tsc && vite build` OK · extension tsc 0 +
esbuild OK · orbe reensamblado · gui de extension actualizado · 25 tests verdes.

### 6.10 Anti-eco / auto-escucha — modo half-duplex (IMPLEMENTADO)

Problema: cuando Lumina hablaba por los altavoces, el micro recapturaba su propia
voz y, aunque el `VoiceActivityGate` subia umbrales (barge-in duplex), el eco se
colaba y ella se auto-contestaba en bucle.

Solucion (opcion 1 del usuario): **half-duplex**. Mientras Lumina esta sonando,
el microfono se IGNORA por completo (no se reenvia a Gemini); al terminar (fin de
la ventana de reproduccion + tail), se reanuda la escucha automaticamente. Ella
termina lo que dice sin interrumpirse y no puede oirse a si misma.

- `core/startTalk/VoiceActivityGate.ts`: nueva opcion `halfDuplex` (default
  `false` en el gate puro para no romper los tests de barge-in). En `processFrame`,
  si `halfDuplex && isAssistantActive()`: cierra un turno abierto si lo hubiera,
  resetea el candidato y limpia el pre-roll (para no filtrar su eco al siguiente
  turno) y retorna sin reenviar.
- `core/startTalk/StartTalkManager.ts`: el gate se crea con
  `{ halfDuplex: true, playbackTailMs: 350 }` por defecto (helper
  `halfDuplexEnabled()`). La ventana "hablando" ya se alimenta de
  `noteAssistantAudio()` (duracion real del audio emitido) + tail de 350 ms.
- Opt-out: `START_TALK_HALF_DUPLEX=false` restaura el barge-in duplex
  (interrumpible). Este cambio corre en core (extension host), NO en el orbe:
  basta esbuild de la extension + recargar el Dev Host, sin recompilar el exe.
- Tests: 2 nuevos en `VoiceActivityGate.vitest.ts` (voz fuerte NO abre turno
  mientras habla; vuelve a escuchar cuando termina). 38 tests startTalk verdes.

Nota (opcion 2, biometria de voz self-ID): el backend ya tiene biometria de voz
(`voiceBiometrics.ts` → `/api/biometric/*`), pero identificar su propia voz en
tiempo real para cancelacion es mas costoso y fragil que el half-duplex. El
half-duplex resuelve el bucle de forma determinista; la self-ID queda como mejora
futura si se quiere duplex real con anti-eco.

### 6.10 Narración diferida de notificaciones de Windows (2026-07-17)

Start Talk puede leer las notificaciones nuevas que Windows publica en el Centro
de notificaciones, sin depender de WSL ni del Windows Bridge:

- `core/startTalk/WindowsNotificationMonitor.ts` mantiene un proceso PowerShell
  oculto que usa la API oficial WinRT `UserNotificationListener`.
- El primer inventario se toma como línea base: al arrancar no narra el historial
  antiguo. Después emite solamente notificaciones nuevas y deduplicadas.
- El monitor se crea y destruye con la sesión de Start Talk. No usa elevación ni
  consulta bases internas de Windows.
- Protocolo nuevo: `notification`, `notificationAccess` y
  `startTalk/setNotificationAnnouncements`.
- Preferencia visible y persistente en Ajustes > Notificaciones de Windows. En
  modo intérprete queda pausada para no contaminar la traducción.

La narración no interrumpe la voz. `useStartTalkAudio.ts` mantiene una cola y
solo envía el siguiente aviso a Gemini cuando se cumplen simultáneamente:

1. Gemini marcó completo el turno actual.
2. No queda ningún `AudioBufferSourceNode` reproduciéndose.
3. No existe otra narración de notificación en vuelo.
4. El usuario lleva al menos 1.2 segundos sin hablar.

Las ráfagas se agrupan hasta cinco avisos, la cola se limita a 50 y un watchdog
recupera el lote si el relay no responde. Si el usuario interrumpe una narración,
el lote vuelve a la cola en vez de perderse.

Seguridad: título y cuerpo se tratan como datos no confiables. El contenido de
una notificación no puede ordenar herramientas ni abrir enlaces. La única
excepción es una llamada interna y tipada para responder una notificación
directa de Phone Link que ya fue clasificada y validada por la política local.

Pruebas añadidas:

- `WindowsNotificationMonitor.vitest.ts`: parser, normalización y rechazo de
  eventos inválidos.
- `notificationAnnouncement.test.ts`: aislamiento de contenido no confiable y
  condición doble de turno completo + audio drenado.
- Smoke test real en Windows: acceso `Allowed`, recepción de toast nuevo y
  extracción correcta de aplicación/título; el toast de prueba se eliminó.

Límite real: “todas” significa todas las notificaciones disponibles mediante la
plataforma de notificaciones de Windows. Avisos legacy, ventanas propias de una
aplicación o eventos que nunca llegan al Centro de notificaciones no pueden ser
observados por esta API.

### 6.11 Phone Link y respuestas directas (2026-07-18)

Start Talk puede responder notificaciones de mensajería reflejadas por Enlace
Móvil. La implementación conserva tres límites independientes:

- `PhoneLinkNotificationPolicy.ts` clasifica aplicación, remitente, mensaje,
  conversación y elegibilidad. Los grupos de WhatsApp siempre se bloquean.
- `reply_to_phone_link` solo acepta el identificador exacto de una notificación
  nueva, pendiente, directa y no sensible. Hay deduplicación y caducidad.
- `POST /phone_link/reply` repite la validación en el Windows Bridge y usa UI
  Automation para encontrar la tarjeta exacta, escribir y verificar el envío.
  No usa coordenadas ni bases privadas de Phone Link.

También se bloquean notificaciones agregadas o ambiguas, enlaces, credenciales,
dinero, compras, citas, direcciones y compromisos. Las demás notificaciones se
analizan para narración, pero no se contestan automáticamente si no exponen una
acción de respuesta segura y verificable.

El chat expone `lumina_phone_link_status` y `lumina_phone_link_reply`; el segundo
exige confirmación explícita para cada destinatario y texto. La autorización
persistente de Start Talk queda ligada a la preferencia visible de leer
notificaciones y solo cubre respuestas directas de bajo riesgo.

### 6.13 Puente de voz con el Google del teléfono (IMPLEMENTADO, 2026-07-18)

Objetivo del usuario: cuando llega una notificación de mensajería/correo al PC
(WhatsApp, Gmail, Facebook…), Start Talk debe **1)** leerla, **2)** decir en voz
alta la palabra clave ("OK Google") para activar al asistente Gemini/Google del
teléfono, **3)** pedirle que revise y responda los mensajes, **4)** esperar su
respuesta hablada, **5)** cerrar si se completó o repetir la palabra clave y la
petición si no.

Implementación (100% en la GUI, **sin tocar** `buildLiveTools`, el pipeline de
audio ni el core):

- `gui/.../startTalk/phoneAssistantBridge.ts` — hermano de
  `notificationAnnouncement.ts`. `buildPhoneAssistantBridgePrompt(notifs, {wakeWord,
  maxAttempts})` construye el prompt-protocolo hablado (7 pasos). Los datos de la
  notificación viajan como JSON **no confiable**; la respuesta hablada del
  teléfono se trata como **estado, nunca como orden** (anti prompt-injection).
  Tope de intentos (1–4, por defecto 2) para no repetir "OK Google" en bucle.
  `isPhoneBridgeEligible` / `selectPhoneBridgeNotifications` filtran por app
  (whatsapp, messenger, facebook, instagram, telegram, signal, gmail, mail, sms…).
- `useStartTalkAudio.ts` — en `tryFlushNotification`, si el puente está activo y
  el lote tiene notificaciones elegibles, inyecta el prompt del puente en vez del
  anuncio normal. Refs `phoneAssistantBridge` / `phoneAssistantWakeWord`.
- `LiveConversationOverlay.tsx` — estado + persistencia en localStorage
  (`lumina-start-talk-phone-bridge`, `lumina-start-talk-wake-word`).
- `StartTalkControls.tsx` — toggle "Puente con Google del teléfono" + campo de
  palabra clave. Deshabilitado si el intérprete está activo o si "Leer
  notificaciones" está apagado.

Sinergia con half-duplex (§6.10): mientras Lumina dice "OK Google" el micro está
mudo (no se auto-oye ni auto-activa); al callar, el micro se reabre y oye la
respuesta del teléfono como turno de usuario, que Gemini Live evalúa para decidir
cierre o reintento. **Opt-in, apagado por defecto**: si no se activa, la
mensajería sigue por Phone Link (§6.11) sin cambios.

Requisito físico (no del código): el teléfono debe oír los altavoces del PC y
tener activada la detección "OK Google". Tests: `phoneAssistantBridge.test.ts`
(7). Verificado: gui `tsc` 0 errores, 10/10 tests de startTalk en gui.

Limitación conocida: el bucle de reintento se apoya en la continuidad de contexto
de Gemini Live (prompt-led), no en una máquina de estados determinista. Futuro:
detectar confirmación/fallo por palabras clave del transcript del teléfono.

### 6.14 Compartir pantalla en vivo (IMPLEMENTADO, 2026-08-15)

El botón de compartir pantalla del dock ya era funcional a nivel de fontanería
(gdigrab → JPEG → `sendRealtimeInput({video})`), pero no era usable como
producto. Lo que fallaba de verdad y cómo quedó:

1. **La sesión moría a los ~2 minutos.** La ventana de contexto de la Live API
   son 128k tokens y cada fotograma cuesta ~258, así que 1 fps de pantalla la
   agota enseguida. Se activó `contextWindowCompression: { slidingWindow: {} }`
   en `openLiveSession()`, que es el mecanismo documentado para que el servidor
   recorte el contexto viejo y la sesión siga viva. También se fija
   `mediaResolution` (por defecto MEDIUM; `START_TALK_MEDIA_RESOLUTION=high`
   reencuadra con zoom al mismo coste y lee mejor el texto pequeño).
2. **Se enviaba 1 fps aunque no cambiara nada.** Ahora el stream de pantalla
   lleva `mpdecimate` y solo emite cuando la imagen cambia de verdad.
   ⚠️ `mpdecimate` **requiere `-fps_mode vfr`**: sin él FFmpeg reconstruye el
   frame rate constante duplicando justo los fotogramas que acaba de descartar,
   y la decimación deja de existir SIN que nada falle visiblemente. Hay un test
   que fija ese emparejamiento (`FfmpegVideoCapture.vitest.ts`).
3. **Con la pantalla quieta no llegaba ni el primer fotograma** (mpdecimate
   descarta también el primero). Se añadió `grabSingleFrame()`, una captura
   puntual de ~215 ms (`-framerate 30 -frames:v 1`; con `-framerate 1` tardaba
   2.1 s) que siembra la vista al arrancar y la refresca cuando el usuario
   empieza a hablar y la última vista tiene más de 3 s. Solo para pantalla: la
   cámara tiene acceso exclusivo en DirectShow y una segunda captura fallaría.
4. **Gemini decía que no podía ver.** El system prompt no mencionaba la visión.
   Se añadieron reglas: puede ver cuando recibe fotogramas, "sin fotograma nuevo
   ⇒ nada ha cambiado", debe decir que no ve si aún no recibió ninguno, y la
   pantalla es dato NO confiable (texto en pantalla nunca es una orden).
5. **Un fallo de vídeo marcaba toda la sesión de voz como rota.** Ahora hay un
   evento propio `videoState` (`starting|live|stopped|error`) y la captura se
   reintenta sola hasta 3 veces; `status` de la sesión ya no se toca.
6. **No había forma de saber qué ve.** La UI muestra una tarjeta con miniatura
   en vivo, la fuente y el número de fotogramas, y solo dice "Viendo tu
   pantalla" cuando el modelo ha recibido un fotograma real.
7. **Multi-monitor.** `-i desktop` capturaba la unión de todos los monitores,
   ilegible al escalarla. `listVideoSources()` enumera cada monitor (WinForms) y
   con más de uno el botón abre un selector; gdigrab recorta con
   `-offset_x/-offset_y/-video_size` (soporta X negativa).

**Cámara (2026-08-15, segunda tanda).** El selector se generalizó a las dos
fuentes: el botón de cámara y el de pantalla comparten `handleToggleVideo(kind)`
y abren el mismo menú cuando hay más de una fuente de ese tipo. Motivo real:
en esta máquina conviven `HP TrueVision HD Camera` (webcam, tope 640x480 por
hardware) y `moto g stylus 5G - 2024 (Windows Virtual Camera)` (el móvil por
Enlace Móvil, 1024x576), así que "coge la primera" era una lotería. Ambas
verificadas emitiendo a 1 fps con los argumentos reales.

`StartTalkVideoSourceInfo` gana `deviceName` separado de `label`: la etiqueta es
texto para el usuario y puede cambiar, `deviceName` es lo que recibe FFmpeg.
`StartTalkVideoStartRequest` gana `label` para que la tarjeta de visión diga qué
monitor/cámara se está usando en vez de un genérico "Pantalla".

⚠️ El nombre de cámara se pasa LITERAL (`video=<nombre>`), sin comillas: se
lanza con array de argumentos, sin shell, así que citarlo lo rompería. Hay test.

Archivos: `FfmpegVideoCapture.ts` (+`buildStreamArgs` exportado y testeado,
`grabSingleFrame`, `listDisplayMonitors`, `listVideoInputDevices`),
`StartTalkManager.ts`, `types.ts`, `index.ts`, `core.ts`, `protocol/core.ts`,
`protocol/passThrough.ts` (nuevo `startTalk/listVideoSources`),
`useStartTalkAudio.ts`, `LiveConversationOverlay.tsx`.

Flags nuevos: `START_TALK_MEDIA_RESOLUTION` (low|medium|high),
`START_TALK_VIDEO_DECIMATE` (false para desactivar, o parámetros de mpdecimate),
`START_TALK_VIDEO_MAX_WIDTH` (default 1280 pantalla / 1024 cámara).

Verificado en vivo contra la API real: la sesión conecta con la nueva config y,
con fotogramas de pantalla, Gemini responde "Estás usando Visual Studio Code y
veo el editor de código, la terminal y una ventana de chat en vivo". Core tsc 0,
67 tests de startTalk en verde, gui build OK, extensión esbuild OK.

### 6.15 Turnos, respuestas largas y cuándo hablar (IMPLEMENTADO, 2026-08-15)

Dos fallos reportados en uso real, los dos reproducidos y medidos antes de
tocar nada.

#### Fallo A — se quedaba muda con texto largo

Medido contra la API real (misma config que `openLiveSession`), leyendo una
respuesta de 3.135 caracteres:

| medida | valor |
|---|---|
| cobertura del texto | **100%** (no truncaba nada) |
| audio generado | 164,2 s |
| ventana de entrega | 54,2 s |
| **velocidad de entrega** | **3,03x tiempo real** |
| `generationComplete` | a los 56,6 s |
| `turnComplete` | a los 166,7 s |

⚠️ **El dato clave: el servidor entrega el audio hasta 3x más rápido que el
tiempo real.** En una respuesta larga el cliente sostiene ~110 s de voz en
cola, y de ahí salían todos los síntomas:

1. **`generationComplete` se trataba como fin de turno.** No lo es: significa
   "terminé de generar", no "terminé de hablar". El orbe pasaba a "escuchando"
   con ~110 s de voz pendiente y las colas de notificaciones y de respuestas de
   chat se desincronizaban. Ahora **solo `turnComplete` cierra el turno**.
2. **La ventana de half-duplex se calculaba por hora de LLEGADA del audio.** Si
   la reproducción se atrasaba o WebView2 suspendía el contexto, core creía que
   ya había terminado, reabría el micro, captaba su propia voz por los altavoces
   y se auto-cortaba — y `interrupted` llama a `stopPlayback()`, que tira la
   cola ENTERA. De ahí "deja de hablar" a media respuesta.
   Ahora la GUI informa cada 500 ms cuánta voz le queda en cola
   (`startTalk/reportPlayback` → `gate.setPlaybackRemaining`). Es autoritativo:
   si la reproducción se suspende, la ventana se alarga sola.
3. **El watchdog de notificaciones era fijo de 45 s** — menos que los 164 s que
   dura una lectura normal, así que saltaba EN MEDIO. Ahora se rearma mientras
   siga sonando voz, con tope de 300 s.
4. **La ruta de respuestas de chat no tenía watchdog.** Si una lectura se
   perdía, `chatResponseInFlight` quedaba en true para siempre y no volvía a
   leer NINGUNA respuesta. Ahora tiene el mismo watchdog rearmable, más una red
   de seguridad en la GUI (`TURN_STUCK_TIMEOUT_MS`) por si `turnComplete` no
   llega nunca.
5. **La rotación de conexión de 12 min cortaba a media frase.** Ahora se aplaza
   mientras quede voz en cola y se dispara al vaciarse.

#### Fallo B — muda en una sala con varias voces

Reproducido con test determinista: **60 s de bulla continua daban 1
`activityStart`, 0 `activityEnd` y 60 s de audio transmitido para nada.**

Causa: el gate solo cerraba turno con 650 ms de silencio real. En una sala con
gente ese silencio **no llega nunca**, así que jamás se enviaba `activityEnd` y
Gemini nunca recibía permiso para responder. No es que decidiera callarse: es
que nadie le daba el turno. Añadido al `VoiceActivityGate`:

- `maxTurnMs` (12 s): techo duro, el turno siempre se cierra.
- Cierre suave por hueco RELATIVO (`softBoundary*`): a partir de 3,5 s se cierra
  en la bajada de energía más profunda respecto al pico del turno, que es el
  límite natural cuando el ruido de fondo nunca calla.
- Detección de entorno (`crowdedWindowMs` / `crowdedVoicedRatio`) → callback
  `onEnvironmentChange`. Una persona con pausas naturales NO cuenta (hay test).

#### Cuándo habla: selectiva

El system prompt decía literalmente *"Speak ONLY when the user has just spoken
to you... Never speak on your own"*: estaba construida para ser reactiva. Ahora:

- Nueva función `stay_silent`. La Live API responde con voz a CADA turno que se
  le cierra; gastar el turno en una llamada sin audio **es** callarse. Core
  responde el tool call y emite `stayedSilent`, sin pasar por la GUI (no hay
  nada que autorizar).
- Reglas de grupo en el prompt: por defecto calla, habla si la interpelan, si le
  preguntan, o si tiene algo que aportar de verdad (corregir un dato falso,
  responder algo que ellos no resolvieron, avisar de algo que le pidieron
  recordar).
- Cuando el entorno cambia, core manda un aviso con **`turnComplete: false`**:
  entra en contexto SIN pedirle respuesta. Verificado: 0/4 veces habló por el
  aviso.

Verificado contra la API real, 9/9:
- Conversación ajena y pregunta entre ellos → `stay_silent`.
- La nombran / pregunta directa → responde.
- Dato falso ("=== convierte tipos") → *"No, eso es incorrecto. El triple igual
  compara valor y tipo sin hacer conversión"*.
- Pregunta que no resuelven → *"El comando es `git reset HEAD~1`"*.
- Charla trivial y planes personales → calla.

#### Interrupción: solo por orden corta

`bargeMode` sustituye a `halfDuplex`. Por defecto `"keyword"`.

⚠️ **No reconoce la palabra literal** — eso exigiría ASR local, que no hay.
Reconoce el *gesto acústico* de cortar a alguien: mientras ella suena, el micro
la está oyendo SIEMPRE por los altavoces, así que un umbral absoluto no
distingue su eco de tu voz. Se mide el nivel del eco en vivo y solo cuenta un
salto de 2,6x sobre él que además sea CORTO (240–1100 ms). Su eco y la bulla son
continuos y se descartan por pasarse del máximo, con cerrojo anti-parrafada para
que una frase larga no se trocee en pedazos del tamaño de una orden.

`START_TALK_BARGE_IN=keyword|energy|off` (`START_TALK_HALF_DUPLEX=false` se
sigue respetando y mapea a `energy`).

Archivos: `VoiceActivityGate.ts` (+8 tests), `StartTalkManager.ts`, `types.ts`,
`index.ts`, `core.ts`, `protocol/core.ts`, `protocol/passThrough.ts` (nuevo
`startTalk/reportPlayback`), `useStartTalkAudio.ts`,
`LiveConversationOverlay.tsx`.

Core tsc 0, gui tsc 0, 76 tests de startTalk en verde, gui build + esbuild +
`start-talk.exe` reconstruidos.

**Pendiente conocido:** cancelación de eco real (AEC). El detector actual es
energía relativa; con AEC de verdad se podría reabrir el barge-in libre sin
riesgo de que se auto-corte.

### 6.16 Modelo, búsqueda propia, métricas y AudioWorklet (IMPLEMENTADO, 2026-08-16)

Tres fases a partir de una revisión técnica externa. Lo medible se midió antes.

#### A. El modelo que corría no era el que creíamos

La UI SIEMPRE manda modelo, así que `DEFAULT_LIVE_MODEL` de core era código
muerto y todas las sesiones corrían `gemini-2.5-flash-native-audio-latest`.
Medido con el mismo texto de 3.135 caracteres, dos pasadas por modelo:

| | 2.5 native-audio | 3.1 flash-live |
|---|---|---|
| cobertura | **84% / 98%** | **100% / 100%** |
| fragmentos | 3.999 / 4.755 | 529 / 565 |
| velocidad | 3,64x / 3,57x | 3,03x / 2,73x |
| generationComplete | 46 s / 56 s | 57 s / 65 s |
| turnComplete | 163 s / 193 s | 167 s / 175 s |

⚠️ **2.5 trunca lecturas largas de forma intermitente.** En la primera pasada
cortó a media frase en el punto séptimo y nunca leyó el cierre. Es una SEGUNDA
causa, independiente de la cola de reproducción (§6.15), del mismo síntoma. Y
manda ~9x más fragmentos por el puente para el mismo audio.

3.1 pasa a ser el primero de `liveModelOptions` (el orden decide el default).

#### B. Búsqueda propia para 3.1

2.5 estaba primero solo por ser el único nivel con grounding nativo de Google
Search; mandar `googleSearch` a 3.1 es un cierre 1011 garantizado. Ahora, sin
grounding nativo, `buildLiveTools` añade la función `search_web`
(`webSearch.ts`), con Tavily del `.env` raíz, Brave de reserva y el orden
tomado de `SEARCH_PROVIDERS`.

Está moldeada para VOZ, que es lo que la diferencia de
`tools/implementations/searchWeb.ts` (ese devuelve hasta 8.000 caracteres por
resultado, correcto para texto e inútil para leer en alto): respuesta
sintetizada de Tavily a 700 caracteres, 3 fuentes como mucho, extractos a 220,
URLs repetidas descartadas.

Verificado en vivo: "¿A cuánto está el bitcoin ahora mismo?" dispara
`search_web` con query "precio actual bitcoin", resuelve en 2,4 s y responde
*"está en aproximadamente sesenta y cuatro mil ciento dieciocho dólares, según
Binance"* — una fuente citada, sin leer URLs. "¿Cuánto es siete por ocho?" no
busca.

⚠️ `buildLiveTools` está EXPORTADA para poder fijarla con tests: fallar ahí es
silencioso en las dos direcciones — `googleSearch` en un modelo incompatible
mata la sesión en bucle de reconexión, y quedarse sin ninguna búsqueda solo
hace que Lumina afirme que no puede acceder a internet.

#### C. Métricas por turno (`TurnMetrics.ts`)

Hasta ahora cada mejora se evaluaba a oído, y eso ya falló dos veces de forma
medible en este proyecto (mpdecimate sin `-fps_mode vfr`; la entrega a 3x que
se creía en tiempo real). Se registran por turno: latencia de respuesta (fin
del turno del usuario → su primer audio), velocidad de entrega, segundos y
fragmentos, interrupciones y **falsos inicios** (turno abierto por el gate sin
transcripción del usuario = tasa de falsos positivos del VAD).

Responder con `stay_silent` NO cuenta como falso inicio: ensuciaría justo la
métrica que sirve para afinar el gate. Percentiles por rango más cercano, así
el número reportado siempre es un valor observado. La UI muestra una franja de
diagnóstico discreta; los contadores en cero no se pintan.

#### D. Reproducción por AudioWorklet (`pcmPlayer.ts`)

Sustituye un `AudioBufferSourceNode` por fragmento. Tres motivos medidos:
la cola solo se podía ESTIMAR y core depende de ese número para no reabrir el
micro mientras ella habla; 4.755 nodos en una sola respuesta pasando por el
hilo principal de React; y los underrun eran invisibles.

El worklet posee un anillo acotado de 30 s y va informando de sus muestras
reales; lo que no cabe se retiene en el hilo principal. Contexto a 24 kHz (tasa
nativa de Gemini) para no remuestrear en la ruta normal.

⚠️ El worklet va INLINE y se carga por Blob URL a propósito: un asset suelto
habría que añadirlo al build de Vite y volver a copiarlo al ensamblar
`orb-frontend` — justo el paso que se olvida y deja el exe con una versión
vieja sin que nada falle visiblemente.

⚠️ `hasQueuedAudio()` es el ÚNICO punto de verdad de "sigue sonando su voz".
Con worklet no hay nodos que contar: preguntar por `outputSources.length` daría
cero a media frase y soltaría las colas antes de tiempo. La ruta clásica queda
como fallback automático si el worklet no arranca.

**Pendiente de esta tanda:** AEC real en WebView2 (getUserMedia con
`echoCancellation` + captura en el WebView), Silero VAD en modo observación,
Smart Turn, embeddings de hablante con sherpa-onnx, modos de conversación
(Solo yo / Conversación / Reunión / Pulsar) y modo reunión con Diart.

### 6.12 Próximas prioridades de Start Talk

1. Supervisor 24/7 con autoarranque, health check y recuperación completa de
   micrófono, Gemini Live y bridge después de suspensión o cambio de red.
2. Cancelación de eco acústica con referencia de salida y pruebas por dispositivo,
   para robustecer conversación full-duplex sin falsos barge-in.
3. Política de notificaciones: aplicaciones permitidas, prioridad, modo privado,
   horas silenciosas, resúmenes y acciones confirmadas (responder/descartar).
4. Diarización multiusuario y detección de destinatario para distinguir cuándo
   una conversación cercana está dirigida a Lumina.
5. Verificación continua de cámara/pantalla: estado visible de frame reciente,
   latencia, fuente y respuesta “no puedo verlo” cuando no exista evidencia.
6. Métricas de streaming por turno: pérdida de audio, jitter, reconexiones,
   latencia de primera voz y correspondencia entre transcript y audio.
