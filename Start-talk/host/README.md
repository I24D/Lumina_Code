# Start Talk — Host standalone

Este paquete es **el host propio de Start Talk**: arranca el `core` de Lumina en
un proceso Node headless (agente, tools, MCP y la voz) y expone el puente
WebSocket del orbe. Es el papel que antes cumplía el host de la extensión de VS
Code — por eso Start Talk necesitaba VS Code abierto. Con esto, deja de
necesitarlo.

## Cómo encaja

```
 orbe (Tauri, src-tauri)  --WebSocket-->  OrbBridgeServer
                                              |
                                        WebviewProtocolHost   (port de webviewProtocol.ts, sin vscode)
                                              |
                                        HostMessenger         (port de VsCodeMessenger: pass-throughs + IDE)
                                          /        \
                                InProcessMessenger   DesktopIde  (extiende FileSystemIde de core)
                                          |
                                    new Core(...)   <-- core sigue viviendo en Lumina-Code, se IMPORTA
                                          |
                              StartTalkManager (voz) + agente + tools + MCP
```

`core` **no se copia**: se consume como librería vía el alias `core/*` de
`tsconfig.json`, que apunta a `../../Lumina-Code/continue-upstream/core`. Si
mueves Lumina-Code, ajusta solo esas dos líneas.

## Archivos

| Archivo | Qué es |
|---|---|
| `src/index.ts` | Arranque: crea messenger + IDE + puente, `new Core(...)`, levanta el orb bridge y publica `~/.lumina/orb-bridge.json`. |
| `src/hostMessenger.ts` | Puente webview↔core (pass-throughs `startTalk/*` + delegación al IDE). Port de `VsCodeMessenger` sin lo del editor. |
| `src/WebviewProtocolHost.ts` | Router gui↔core. Port de `webviewProtocol.ts` sin `vscode`. |
| `src/OrbBridgeServer.ts` | Servidor WS del orbe (127.0.0.1, puerto efímero + token). Port casi verbatim. |
| `src/DesktopIde.ts` | IDE headless (extiende `FileSystemIde` de core). |
| `src/bridgeDiscovery.ts` | Escribe/lee `{port,token}` para que el orbe se conecte solo. |

## Estado — ARRANCA (verificado 2026-08-11)

El host **bootea bajo Node**, carga la config real, levanta el core completo
(el WhatsApp auto-responder se pone online) y publica el bridge en
`~/.lumina/orb-bridge.json`. Boot limpio, sin errores.

### Recipe reproducible

```
# 1) dependencias del host
npm install

# 2) bundle (modo esbuild-only, como binary/build.js)
node_modules/.bin/esbuild src/index.ts --bundle --outfile=dist/index.cjs \
  --format=cjs --platform=node --target=node18 --tsconfig=tsconfig.json \
  --external:esbuild --external:vscode --external:./index.node \
  --external:./xhr-sync-worker.js --external:llamaTokenizerWorkerPool.mjs \
  --external:tiktokenWorkerPool.mjs --loader:.node=file \
  --inject:../../Lumina-Code/continue-upstream/binary/importMetaUrl.js \
  --define:import.meta.url=importMetaUrl

# 3) assets de runtime que el bundle deja externos (copiar desde core):
#    core/node_modules/jsdom/.../xhr-sync-worker.js   -> dist/
#    core/llm/tiktokenWorkerPool.mjs                  -> dist/
#    core/llm/llamaTokenizerWorkerPool.mjs            -> dist/
#    core/llm/llamaTokenizer.mjs                      -> dist/
#    core/vendor/tree-sitter.wasm                     -> dist/
#    core/node_modules/tree-sitter-wasms/out          -> dist/tree-sitter-wasms/
#    core/node_modules/sqlite3/build/Release/node_sqlite3.node -> build/Release/
#    core/node_modules/@lancedb/*                      -> node_modules/@lancedb/

# 4) arrancar
LUMINA_WORKSPACE=C:\I24D_WhatsApp node dist/index.cjs
# -> [start-talk-host] listo. Orbe -> ws://127.0.0.1:<port>/?token=<token>
```

### Lo que FALTA (siguiente etapa)

1. **Cerrar el cordón** (`src-tauri/src/lib.rs`): si no hay env
   `LUMINA_ORB_BRIDGE`, leer `~/.lumina/orb-bridge.json`. Y que el Rust lance este
   host al abrir el orbe.
2. **Verificar el flujo de voz** de punta a punta (orbe conectado a este host).
3. **Empaquetar** los pasos 2-3 en un script TS de build (evitar copias manuales).
