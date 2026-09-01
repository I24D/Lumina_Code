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

El runtime ya no depende directamente de una clase concreta de Gemini u
OpenAI. `VoiceProviderRouter` registra proveedores bajo un contrato común y
declara si su arquitectura es speech-to-speech (`native-realtime`) o el
pipeline modular `stt-llm-tts`. Los adaptadores activos hoy son OpenAI
Realtime y Gemini Live; el contrato modular está listo para conectar STT, LLM
y TTS intercambiables sin tocar la interfaz, pero no se presenta como proveedor
seleccionable hasta que exista un adaptador completo.

Cuando las dos claves están configuradas, el proveedor no elegido queda como
respaldo automático. Una conexión tiene un límite de 15 segundos y los fallos
se clasifican (credenciales, configuración/modelo, cuota, rate limit, red o
servidor). Los errores transitorios usan backoff exponencial con un máximo de
ocho intentos; un error terminal o el agotamiento de reintentos cambia al
proveedor secundario una sola vez. Si tampoco conecta, la UI pasa a **Error**
con una causa concreta: nunca permanece indefinidamente en **Conectando**.

Diferencias reales entre los dos, no cosméticas:

- el grounding nativo de Búsqueda de Google solo existe en Gemini; en OpenAI la
  búsqueda entra por la función `search_web`, que se envía siempre;
- la reanudación con handle y la rotación de conexión son del límite de sesión
  de la Live API, así que en OpenAI están apagadas en vez de simuladas;
- el modo intérprete usa el modelo `live-translate` dedicado en Gemini y el
  mismo modelo de tiempo real con el prompt de intérprete en OpenAI.

## Audio

- El micrófono se abre dentro del navegador para usar la cancelación de eco,
  supresión de ruido y ganancia automática de WebRTC.
- La selección de entrada usa el `deviceId` real. Dos micrófonos con la misma
  etiqueta visible siguen siendo seleccionables de forma independiente.
- El audio se convierte a PCM mono de 16 kHz antes de entrar al gate de voz.
- El gate adapta su piso de ruido, conserva límites máximos de turno y distingue
  voz, ruido no vocal y solapamiento sostenido de varias voces.
- El cierre de turno combina VAD, la transcripción parcial, el estado de la
  conversación y el ritmo aprendido. Respeta conectores o frases incompletas y
  aprende la mediana de las pausas internas del hablante, siempre dentro de un
  límite de 420 a 1600 ms para no dejar un turno colgado.
- La cola de reproducción reporta su duración real a core. Esto evita que el
  micrófono vuelva a abrir el turno mientras la voz de Lumina aún está sonando.
- Si desaparece el micrófono seleccionado o muere su pista, la GUI vuelve a
  enumerar dispositivos y recupera la captura. Un cambio de lista que no afecta
  al dispositivo activo no reinicia el audio.

La pantalla avanzada muestra lo que Chromium aplicó realmente. Si aparece
`sin AEC`, el dispositivo o el controlador no concedió cancelación de eco,
aunque se haya solicitado.

## Runtime de conversación, interrupción y cancelación

`ConversationTurnManager` mantiene una máquina de estados observable:
`IDLE`, `LISTENING`, `USER_SPEAKING`, `THINKING`, `ASSISTANT_SPEAKING`,
`INTERRUPTED`, `TOOL_EXECUTION`, `RECONNECTING` y `ERROR`. La zona central de
Lumina Live muestra ese estado aunque todavía no haya una tarjeta de
herramienta, evitando que una espera parezca una congelación.

El barge-in mantiene el micrófono activo y usa AEC más un gate dúplex para no
confundir los altavoces con el usuario. Al confirmar una interrupción se vacía
el reproductor, se invalida la generación del turno y se abortan búsquedas,
recuperación de memoria y la tarea delegada al chat principal. La cancelación
de esa tarea viaja con su `requestId`, por lo que no puede detener por accidente
un chat escrito por el usuario. Los resultados tardíos se descartan mediante
una generación monotónica y no vuelven a aparecer como respuestas fantasma.

El modo `keyword` predeterminado detecta el gesto acústico breve de cortar la
voz, pero no reconoce palabras localmente. `START_TALK_BARGE_IN=energy` habilita
interrupción por habla sostenida y `off` fuerza half-duplex.

Un «ajá» dicho mientras Lumina habla encaja exactamente en el perfil acústico de
una orden corta, así que el gate lo trata como un corte. Como el gate mide
energía y no palabras, esto no se puede evitar antes de que exista transcripción:
lo que se hace es repararlo. Al cerrar el turno, si empezó cortándola y lo
transcrito hasta ese momento es solo la interjección, se le manda una nota de
contexto pidiéndole que siga la respuesta por donde iba, justo antes del
`activityEnd` que dispara la generación —después llegaría cuando ya está
respondiendo al «ajá», y serían dos respuestas. El corte ya ocurrió y se sigue
contando como interrupción; los asentimientos se cuentan aparte en
`backchannels`, y comparar las dos cifras es lo que dice si el barge-in salta de
más. Cuando el endpoint local se adelanta a la transcripción del proveedor no
hay texto que juzgar y el turno sigue su curso normal.

## Respuesta hablada y streaming

Los proveedores realtime entregan transcripción y audio de forma incremental.
Las respuestas finales que vienen del agente principal pasan por
`VoiceResponseComposer`: el texto completo continúa visible en el chat, pero
la voz omite bloques de código y URLs largas en lugar de leer caracteres sin
utilidad. El segmentador incremental libera oraciones completas para el
adaptador `stt-llm-tts`, de modo que un futuro TTS modular podrá comenzar antes
de que termine toda la respuesta del LLM.

Esta separación es intencional: el proveedor de voz escucha y habla; Lumina
Code puede delegar el razonamiento y las herramientas a su modelo principal
(Ollama Cloud, OpenAI, Anthropic u otro proveedor compatible) tras una
autorización explícita. Así Start Talk no fuerza que el modelo de voz sea
también el modelo que modifica código.

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

### Búsqueda adelantada

Cuando la frase ya pide buscar algo —«busca en internet cuál es el modelo de voz
más reciente de Gemini»—, la búsqueda arranca con la transcripción parcial, sin
esperar a que el turno se cierre y el modelo llame a `search_web`. Si al llegar
la llamada la consulta es la misma pregunta, la respuesta ya está y se ahorra el
viaje completo a la red.

Solo se adelanta la búsqueda, que es de solo lectura. Ninguna acción con efectos
—responder un mensaje, tocar el PC, delegar una tarea— se ejecuta antes de que
el modelo la pida y el usuario la autorice.

Los límites existen porque cada adelanto fallido es una llamada pagada:

- Hace falta una petición explícita de búsqueda. «¿Cuál es la última versión?»
  no la dispara aunque a menudo acabe en una búsqueda.
- Un adelanto por turno, y solo cuando el parcial no está cortado a media frase.
- El resultado se reutiliza únicamente si la consulta que pide el modelo es la
  misma pregunta; si el usuario cambió de idea a mitad, se descarta. Contestar
  la pregunta de al lado es peor que tardar.
- Solo se activa cuando es esta sesión la que busca. Con el grounding nativo de
  Google el modelo resuelve dentro y nunca llama a `search_web`.

La tira de métricas muestra cuántas búsquedas venían adelantadas. Comparado con
el total dice si el detector de intención acierta o solo está gastando.

Los extractos y páginas recuperados se etiquetan internamente como
`UNTRUSTED_EXTERNAL_DATA`. El prompt del sistema prohíbe tratarlos como órdenes
o elevarlos por encima de las instrucciones del usuario. Mostrar una fuente no
autoriza ejecutar acciones, y toda herramienta sensible conserva su política
de permisos y confirmación.

## Conexión, observabilidad y costo

El puente local envía heartbeat cada cinco segundos, exige confirmación en un
máximo de quince y reconecta con backoff limitado. La sesión del proveedor
mantiene su propia recuperación; OpenAI añade ping/pong de transporte y Gemini
conserva sus handles de reanudación cuando la API los ofrece.

Por turno se miden duración de voz de entrada, primer parcial STT, primer token
de texto, endpointing, red/modelo hasta el primer audio, tiempo de herramientas,
audio de salida, delivery rate, interrupción y falso positivo. La sesión agrega
mediana/p90, reconexiones, búsquedas, llamadas de herramientas y segundos de
audio. El costo solo se estima si el operador configura tarifas explícitas:

- `START_TALK_COST_INPUT_AUDIO_USD_PER_MINUTE`
- `START_TALK_COST_OUTPUT_AUDIO_USD_PER_MINUTE`
- `START_TALK_COST_TOOL_CALL_USD`

No se inventan precios ni costos de tokens que el proveedor no haya reportado.
La telemetría queda en memoria para diagnóstico de la sesión y no contiene el
audio ni las claves.

## Diagnóstico rápido

1. Abre **Ajustes de conversación → Entrada de audio** y actualiza la lista.
2. Confirma que la pantalla de métricas diga `eco cancelado`.
3. Si Lumina Live no conecta, ábrelo desde el botón del chat o el comando de la
   extensión; una URL copiada de otra sesión ya no tiene un token válido.
4. Comprueba que la clave del proveedor activo (`OPENAI_API_KEY` o
   `GEMINI_API_KEY`) esté puesta y que el modelo sea de ese mismo proveedor.
5. Mantén la biometría apagada si no has instalado su backend opcional.
6. Si hubo una interrupción, comprueba que la tarea delegada aparezca cancelada
   en el chat y no continúe ejecutando herramientas en segundo plano.
