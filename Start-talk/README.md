# Lumina Live — Start Talk

Start Talk es la interfaz de voz de Lumina Code. Se abre como una pestaña del navegador que sirve la extensión de VS Code desde `127.0.0.1`, se conecta a ella por un puente local autenticado y permite conversar con el agente por voz en tiempo real, con la Realtime API de OpenAI o con Gemini Live.

> Hasta el 2026-08-28 Start Talk fue una ventana de escritorio Tauri que embebía la interfaz en un `.exe`. Se cambió a una pestaña para eliminar el `cargo build` de ~7 minutos por cada cambio de interfaz, los fallos silenciosos por bundle desincronizado y el ejecutable bloqueado. Lo que se perdió a cambio —una ventana flotante siempre encima— fue una decisión consciente.

## Qué incluye

- conversación de voz bidireccional en tiempo real;
- transcripción visible de la conversación;
- núcleo energético animado con tenazas, aura y reacción al micrófono y a la voz;
- evidencia visible de cada búsqueda web: consulta, proveedor, síntesis y fuentes;
- lectura en voz alta de respuestas finales de Lumina Code, Claude Code y Codex;
- selección nativa y segura del navegador para cámara, pantalla, ventana o
  pestaña, con indicador del sistema y detención desde cualquiera de los dos;
- autorización explícita antes de enviar tareas de voz al agente;
- vista compacta o ampliada, con pantalla completa del navegador.

## Interfaz de conversación

La pestaña de Lumina Live utiliza una sola interfaz de tres zonas, adaptable al
tamaño del navegador:

- **Tú hablas:** transcripción cronológica y medidor del micrófono;
- **Acciones en curso:** núcleo energético animado y estado real de búsquedas,
  análisis, herramientas y tareas;
- **Start Talk responde:** respuestas completas, reproducción de voz y fuentes
  consultadas con enlaces verificables.

No son tarjetas de demostración: durante una sesión, todo el contenido proviene
de la transcripción, las actividades y las fuentes emitidas por el agente. La
vista pasa a dos columnas en tablet y a una columna ordenada en móvil, sin
perder controles ni información.

Start Talk no es una aplicación independiente: se abre con el botón **Start talk** del chat o con el comando **Lumina Code: Start Talk**, porque es la extensión quien sirve la interfaz y crea el puente autenticado. Abrir la URL a mano sin el token devuelve 403.

## Requisitos

- Node.js y npm;
- un navegador moderno (el micrófono funciona porque `127.0.0.1` es contexto
  seguro; la primera vez pedirá permiso para ese origen);
- la clave del proveedor de voz que vayas a usar: `OPENAI_API_KEY` (por
  defecto) o `GEMINI_API_KEY` de Google AI Studio.

## Proveedor y voz

Start Talk viene configurado con **OpenAI Realtime** y el modelo de voz más
reciente, `gpt-realtime-2.1`, con la voz **Marin**: femenina, joven y brillante,
exclusiva de la API de tiempo real. Gemini Live sigue disponible con la voz
**Leda** (también femenina y juvenil).

El proveedor, el modelo y la voz se eligen en **Ajustes → Start Talk** dentro de
Lumina Code, y también desde el selector de modelo del propio orbe. El
proveedor se deduce del modelo, así que nunca se envía la clave o la voz de uno
a la API del otro. Puedes dejar las dos claves guardadas y alternar.

Los detalles de cada backend están en la [guía de voz y multimedia](../docs/VOICE_AND_MULTIMEDIA.md).

La clave de voz se utiliza únicamente para la experiencia de voz. El chat y el agente principal pueden usar otro proveedor; la configuración de referencia del proyecto es Ollama Cloud con `glm-5.2:cloud`.

## Latencia y calidad de audio

La ruta de voz está optimizada para conversación interactiva sin depender de
flags experimentales del navegador:

- captura mono PCM a 16 kHz en bloques de 40 ms, con cancelación de eco,
  supresión de ruido y ganancia automática de WebRTC;
- transporte unidireccional para el audio continuo, sin una respuesta del
  puente por cada bloque;
- VAD local de 20 ms con pre-roll de 280 ms y cierre de 520 ms en conversación
  normal; en una sala con varias voces conserva 700 ms para no fragmentarlas;
- salida PCM nativa a 24 kHz mediante AudioWorklet con prioridad interactiva,
  precalentada mientras se conecta el proveedor de voz;
- presupuesto máximo de 750 ms para memoria y contexto auxiliar durante el
  arranque, de modo que un servicio opcional caído no bloquee Lumina Live;
- diagnóstico visible que separa la latencia total percibida de la latencia de
  red/modelo del último turno.
- máquina de estados de conversación visible, endpointing semántico/adaptativo
  y recuperación automática si desaparece el micrófono activo;
- router multiproveedor con timeout, backoff limitado y fallback automático
  entre OpenAI Realtime y Gemini Live cuando ambas claves están configuradas;
- cancelación real por turno: una interrupción aborta audio, búsquedas y la
  tarea delegada exacta del agente, sin detener chats manuales no relacionados.

El VAD manual es deliberado: evita que el eco o una voz de fondo interrumpan a
Lumina, permite conservar el barge-in autorizado y mantiene límites especiales
para conversaciones con varias personas.

Las respuestas finales delegadas al agente conservan código, URLs y detalles
en pantalla, pero un compositor de voz evita leer bloques de código o enlaces
largos literalmente. Las métricas incluyen primer parcial STT, primer token,
tiempo de herramientas, primer audio, percentiles de latencia y duración real
de audio. Las tarifas opcionales para estimar costo están documentadas en la
[guía de voz y multimedia](../docs/VOICE_AND_MULTIMEDIA.md).

## Desarrollo

Esta carpeta ya no contiene la interfaz: vive entera en `continue-upstream/gui`
y la sirve la extensión. Un cambio de interfaz son dos pasos:

```powershell
Set-Location "..\continue-upstream\gui"
npm run build
# y recargar la pestaña del orbe (F5)
```

En desarrollo se sirve `gui/dist`, no la copia empaquetada en
`extensions/vscode/gui`, que solo se refresca al generar el VSIX. Lo decide
`resolveOrbFrontendRoot` según el modo de la extensión, para que la pestaña no
pueda mostrar una interfaz de hace días sin que nada falle.

Arranca Lumina Code con el launcher de la raíz del repositorio, que reconstruye
`gui/dist` solo si detecta fuentes más nuevas.

Lo que queda aquí son piezas independientes del orbe: `host/` (core headless sin
VS Code), `services/`, `integrations/` (hooks de voz para Claude Code y Codex) y
`runtime/`.

Consulta el [README principal](../README.md) para configurar modelos y la [guía de instalación del VSIX](../docs/INSTALLATION_AND_VSIX.md) para el flujo completo.

## Seguridad

El puente entre Start Talk y VS Code escucha únicamente en `127.0.0.1` y utiliza un token efímero por sesión, exigido tanto para servir la página como para abrir el WebSocket. El token se borra de la barra de direcciones nada más cargar, para que no quede en el historial. Las tareas detectadas por voz requieren autorización explícita del usuario antes de enviarse al agente. No publiques claves API, archivos `.env` ni registros personales.

## English

Start Talk is Lumina Code's voice interface. It runs as a browser tab served by the VS Code extension over an authenticated local bridge on `127.0.0.1`, streams real-time audio through the OpenAI Realtime API (`gpt-realtime-2.1`, voice "marin") or Gemini Live, displays the conversation transcript, and requires explicit approval before a voice request becomes an agent task. Open it from the chat's Start talk button or the command palette; opening the URL by hand without the session token returns 403.
