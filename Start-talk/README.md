# Lumina Live — Start Talk

Start Talk es la interfaz de voz nativa de Lumina Code. Se ejecuta como una aplicación de escritorio Tauri para Windows, se conecta de forma segura con la extensión de VS Code y permite conversar con el agente por voz en tiempo real, con la Realtime API de OpenAI o con Gemini Live.

## Qué incluye

- conversación de voz bidireccional en tiempo real;
- transcripción visible de la conversación;
- núcleo energético animado con tenazas, aura y reacción al micrófono y a la voz;
- evidencia visible de cada búsqueda web: consulta, proveedor, síntesis y fuentes;
- lectura en voz alta de respuestas finales de Lumina Code, Claude Code y Codex;
- selección de micrófono, cámara o monitor;
- autorización explícita antes de enviar tareas de voz al agente;
- ventana compacta o experiencia ampliada siempre visible.

Start Talk no es una aplicación independiente: debe iniciarse desde el comando **Lumina Code: Start Talk (orbe de escritorio)** para que la extensión cree el puente local autenticado.

## Requisitos

- Windows 10/11 x64;
- Rust con toolchain `stable-msvc`;
- Microsoft C++ Build Tools;
- Microsoft Edge WebView2;
- Node.js y npm;
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

El VAD manual es deliberado: evita que el eco o una voz de fondo interrumpan a
Lumina, permite conservar el barge-in autorizado y mantiene límites especiales
para conversaciones con varias personas.

## Desarrollo

```powershell
cd Start-talk
npm install
npm run dev
```

El comando compila `continue-upstream/gui`, sincroniza el bundle completo con
`orb-frontend`, valida que ambas copias sean idénticas y entonces inicia Tauri.
Así el orbe no puede abrir silenciosamente una interfaz anterior.

Para generar el ejecutable que se incluye en el VSIX:

```powershell
npm run build
Test-Path .\src-tauri\target\release\start-talk.exe
```

`npm run build` siempre vuelve a ensamblar la GUI antes de generar el `.exe`.
Al terminar también elimina la caché binaria de Cargo, incluidas las copias de
`deps`, `debug` o `start-talk.old.exe`: la única ruta válida en desarrollo es
`src-tauri/target/release/start-talk.exe`. `npm run check` falla si reaparece
alguna copia ambigua.
Si solo necesitas refrescar la copia embebible, usa
`npm run prepare:frontend`; `npm run check` falla cuando la copia o el
ejecutable quedaron atrasados.

Después inicia Lumina Code con el launcher de la raíz del repositorio. Ejecutar `start-talk.exe` directamente omite el puente de sesión y no permite comunicarse con la extensión.

Consulta el [README principal](../README.md) para configurar modelos y la [guía de instalación del VSIX](../docs/INSTALLATION_AND_VSIX.md) para el flujo completo.

## Seguridad

El puente entre Start Talk y VS Code escucha únicamente en `127.0.0.1` y utiliza un token efímero por sesión. Las tareas detectadas por voz requieren autorización explícita del usuario antes de enviarse al agente. No publiques claves API, archivos `.env` ni registros personales.

## English

Start Talk is Lumina Code's native Windows voice interface. It connects to the VS Code extension through an authenticated local bridge, streams real-time audio through the OpenAI Realtime API (`gpt-realtime-2.1`, voice "marin") or Gemini Live, displays the conversation transcript, and requires explicit approval before a voice request becomes an agent task. Start it from the Lumina Code command palette rather than launching the executable directly.
