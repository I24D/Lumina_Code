# Voz y multimedia de Start Talk

Start Talk usa la misma GUI y el mismo core de Lumina Code. El orbe Tauri no
mantiene una implementación paralela: transporta los mensajes del webview al
host de la extensión mediante el puente autenticado local.

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
3. Si el orbe no conecta, ábrelo desde el comando de la extensión; ejecutar el
   `.exe` directamente omite el puente autenticado.
4. Comprueba `GEMINI_API_KEY` y el modelo Live siguiendo el README.
5. Mantén la biometría apagada si no has instalado su backend opcional.
