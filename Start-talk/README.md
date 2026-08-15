# Lumina Live — Start Talk

Start Talk es la interfaz de voz nativa de Lumina Code. Se ejecuta como una aplicación de escritorio Tauri para Windows, se conecta de forma segura con la extensión de VS Code y permite conversar con el agente mediante Gemini Live.

## Qué incluye

- conversación de voz bidireccional en tiempo real;
- transcripción visible de la conversación;
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
- una `GEMINI_API_KEY` de Google AI Studio.

La clave de Gemini se utiliza únicamente para la experiencia de voz. El chat y el agente principal pueden usar otro proveedor; la configuración de referencia del proyecto es Ollama Cloud con `glm-5.2:cloud`.

## Desarrollo

```powershell
cd Start-talk
npm install
npm run tauri dev
```

Para generar el ejecutable que se incluye en el VSIX:

```powershell
npm run tauri build -- --no-bundle
Test-Path .\src-tauri\target\release\start-talk.exe
```

Después inicia Lumina Code con el launcher de la raíz del repositorio. Ejecutar `start-talk.exe` directamente omite el puente de sesión y no permite comunicarse con la extensión.

Consulta el [README principal](../README.md) para configurar modelos y la [guía de instalación del VSIX](../docs/INSTALLATION_AND_VSIX.md) para el flujo completo.

## Seguridad

El puente entre Start Talk y VS Code escucha únicamente en `127.0.0.1` y utiliza un token efímero por sesión. Las tareas detectadas por voz requieren autorización explícita del usuario antes de enviarse al agente. No publiques claves API, archivos `.env` ni registros personales.

## English

Start Talk is Lumina Code's native Windows voice interface. It connects to the VS Code extension through an authenticated local bridge, uses Gemini Live for real-time audio, displays the conversation transcript, and requires explicit approval before a voice request becomes an agent task. Start it from the Lumina Code command palette rather than launching the executable directly.
