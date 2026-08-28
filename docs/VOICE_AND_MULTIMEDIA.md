# Voz y multimedia de Start Talk

Start Talk usa la misma GUI y el mismo core de Lumina Code, sin implementación
paralela. Se abre como una **pestaña del navegador**: `OrbBridgeServer` sirve el
bundle de la GUI en `127.0.0.1` e inyecta un arranque que sustituye
`vscode.postMessage` por un WebSocket contra el mismo `VsCodeWebviewProtocol`.
Así las tools, MCP y la delegación al agente funcionan idénticas a la barra
lateral.

Tanto la página como el WebSocket exigen el token de sesión, que crea el comando
de Lumina Code; el token se borra de la barra de direcciones al cargar. Como
`127.0.0.1` es contexto seguro, el micrófono y el AudioWorklet funcionan con
normalidad (la primera vez el navegador pedirá permiso).

Hasta el 2026-08-28 el orbe fue una ventana Tauri que embebía la GUI en un
`.exe`. Se cambió por la pestaña para eliminar el `cargo build` de ~7 minutos
por cada cambio de interfaz y los fallos silenciosos por bundle desincronizado;
el precio consciente fue perder la ventana flotante siempre encima.

## Proveedores de voz

Hay dos backends de tiempo real y comparten todo lo demás (puerta de voz,
vídeo, funciones, métricas, reconexión). Se eligen en **Ajustes → Start Talk**:

| Proveedor | Modelo por defecto | Voz por defecto | Clave |
| --- | --- | --- | --- |
| OpenAI Realtime | `gpt-realtime-2.1` | `marin` (mujer joven) | `OPENAI_API_KEY` |
| Gemini Live | `gemini-3.1-flash-live-preview` | `Leda` (mujer joven) | `GEMINI_API_KEY` |

El proveedor se deduce del modelo elegido, así que una voz o una clave no
pueden acabar en la API del otro. En el orbe, el modelo **Automático** usa el
proveedor configurado en Ajustes y muestra cuál acabó conectando.

Variables de entorno reconocidas, además de las claves:
`START_TALK_PROVIDER`, `START_TALK_OPENAI_MODEL`, `START_TALK_OPENAI_VOICE`,
`START_TALK_OPENAI_TRANSCRIBE_MODEL`, `START_TALK_GEMINI_MODEL`,
`START_TALK_GEMINI_VOICE` y `START_TALK_GEMINI_THINKING_LEVEL`.

Diferencias reales entre los dos, no cosméticas:

- el grounding nativo de Búsqueda de Google solo existe en Gemini; en OpenAI la
  búsqueda entra por la función `search_web`, que se envía siempre;
- la reanudación con handle y la rotación de conexión son del límite de sesión
  de la Live API, así que en OpenAI están apagadas en vez de simuladas;
- el modo intérprete usa el modelo `live-translate` dedicado en Gemini y el
  mismo modelo de tiempo real con el prompt de intérprete en OpenAI.

## Audio

- El micrófono se abre dentro de WebView2 para usar la cancelación de eco,
  supresión de ruido y ganancia automática de WebRTC.
- La selección de entrada usa el `deviceId` real. Dos micrófonos con la misma
  etiqueta visible siguen siendo seleccionables de forma independiente.
- El audio se convierte a PCM mono de 16 kHz antes de entrar al gate de voz.
- El gate adapta su piso de ruido, conserva límites máximos de turno y distingue
  voz, ruido no vocal y solapamiento sostenido de varias voces.
- La cola de reproducción reporta su duración real a core. Esto evita que el
  micrófono vuelva a abrir el turno mientras la voz de Lumina aún está sonando.

La pantalla avanzada muestra lo que Chromium aplicó realmente. Si aparece
`sin AEC`, el dispositivo o el controlador no concedió cancelación de eco,
aunque se haya solicitado.

## Varias voces e identificación opcional

Cuando hay voces solapadas, la interfaz informa **Varias voces detectadas** y
Lumina adopta el comportamiento de entorno concurrido: no debe intervenir salvo
que se la mencione o tenga información claramente útil.

La biometría es opcional y está desactivada por defecto. Se habilita con
`START_TALK_BIOMETRICS=true` cuando el backend biométrico está instalado. Cada
resultado lleva un identificador monotónico de turno: una respuesta lenta de un
turno anterior no puede cambiar el nombre mostrado para la voz actual. Los
clips demasiado cortos no se envían y una respuesta remota inválida se trata
como voz no reconocida.

Esta función identifica la voz predominante de un turno contra identidades ya
registradas. No pretende separar matemáticamente dos voces simultáneas ni
presenta el solapamiento como diarización completa.

## Memoria persistente (Supabase)

Start Talk recuerda entre sesiones usando directamente el cerebro de Lumina en
Supabase (proyecto `Lumina_IA`): las tablas `long_term_memories`, `memory_wiki`,
`knowledge_entries`, `user_profiles` y `conversations`, con búsqueda semántica
por embeddings (`text-embedding-3-small`, 1536 dimensiones).

Tres momentos:

- **Al conectar** carga un bloque de memoria (perfil, memorias durables
  recientes y últimos mensajes) y lo inyecta en el system prompt, para que la
  voz arranque "recordando" al usuario. Nunca lo lee en voz alta ni anuncia que
  tiene memoria.
- **Durante la conversación**, la función `recall_memory` busca semánticamente
  en las memorias, la wiki de conocimiento y la base de preguntas/respuestas
  cuando necesita recordar algo concreto. Aparece como una tarjeta **Memoria**
  en el panel de actividad, igual que las búsquedas web.
- **Al cerrar**, extrae de la conversación un hecho durable, lo vectoriza y lo
  guarda, de modo que la próxima sesión ya parte sabiéndolo. También guarda el
  hilo reciente.

La conexión se activa sola cuando el `.env` de la raíz tiene `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` y `OPENAI_API_KEY`. La `service_role` solo se usa en
core (host de la extensión) y viaja únicamente hacia Supabase: jamás llega al
webview. Todo es best-effort — si falta una credencial o Supabase no responde a
tiempo, la conversación sigue sin memoria en vez de fallar. Bloquear **Memoria
de conversaciones** en Privacidad la apaga por completo (recall y aprendizaje).
El modo intérprete nunca recuerda ni aprende: solo traduce.

Variables opcionales: `START_TALK_WIKI_USER_ID` (por defecto `lumina`, el
`user_id` de la wiki) y `START_TALK_MEMORY_SUMMARY_MODEL` (por defecto
`gpt-4o-mini`, el modelo que resume la conversación al aprender).

La búsqueda semántica ignora las filas sin vector. Si se añaden datos a mano en
esas tablas, hay que rellenar sus embeddings:

```powershell
Set-Location "C:\Lumina Code\continue-upstream\core"
node scripts/backfillMemoryEmbeddings.mjs --dry-run   # cuenta lo que falta
node scripts/backfillMemoryEmbeddings.mjs             # los rellena
```

El script es idempotente y no destructivo: solo toca filas con `embedding` en
NULL.

## Multimedia y permisos

La cámara y la pantalla se eligen por fuente, reportan su estado real y pueden
detenerse sin cerrar la sesión de voz. Micrófono, cámara, pantalla,
notificaciones y acciones de escritorio conservan controles de privacidad
independientes. Una transcripción de voz nunca equivale por sí misma a aprobar
una tarea o una acción sensible.

## Transparencia de las búsquedas web

Cada búsqueda realizada durante una conversación aparece en el panel de
actividad de Start Talk. La tarjeta se puede desplegar para revisar la consulta
enviada, el proveedor, el resumen recibido y las fuentes citadas.

- Con Tavily o Brave, Lumina muestra también los extractos exactos entregados
  al modelo de voz. Esto permite comprobar qué material estaba realmente en su
  contexto, sin afirmar que leyó una página completa cuando solo recibió un
  fragmento.
- La búsqueda nativa de Google Live solo expone al cliente las consultas y las
  citas. En ese caso la interfaz lo indica expresamente: los extractos que
  Google procesó en sus servidores no están disponibles para mostrarlos.
- Solo se pueden abrir enlaces `http` o `https`; credenciales y fragmentos de
  URL se eliminan antes de enviarlos a la interfaz.

La actividad conserva las 50 operaciones más recientes de la sesión para que
una conversación larga no aumente la memoria sin límite.

## Diagnóstico rápido

1. Abre **Ajustes de conversación → Entrada de audio** y actualiza la lista.
2. Confirma que la pantalla de métricas diga `eco cancelado`.
3. Si Lumina Live no conecta, ábrelo desde el botón del chat o el comando de la
   extensión; una URL copiada de otra sesión ya no tiene un token válido.
4. Comprueba que la clave del proveedor activo (`OPENAI_API_KEY` o
   `GEMINI_API_KEY`) esté puesta y que el modelo sea de ese mismo proveedor.
5. Mantén la biometría apagada si no has instalado su backend opcional.
