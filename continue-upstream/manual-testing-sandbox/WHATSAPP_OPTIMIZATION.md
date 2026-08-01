# Integración de WhatsApp en Lumina Code

**Última actualización:** 2026-07-23  
**Runtime:** Lumina Windows Bridge (`http://127.0.0.1:8765`)

## Resumen

Lumina Code controla WhatsApp mediante Windows UI Automation y el Windows
Bridge local. No usa coordenadas fijas, no abre un navegador separado y no
depende de OpenClaw. La carpeta `openclaw-windows-bridge-lab` conserva un nombre
histórico, pero el proceso usado por Lumina Code es únicamente el bridge nativo
de Windows.

La integración ahora cubre:

- Identificar y buscar contactos o conversaciones.
- Leer nombres, horas, previews y cantidad de mensajes sin leer.
- Abrir una conversación y leer mensajes recientes con dirección, remitente,
  hora y estado de entrega.
- Enviar texto.
- Enviar imágenes, videos, audio y documentos con texto opcional.
- Listar autores de estados sin abrir el estado individual.
- Publicar estados con foto o video.
- Publicar texto como un estado visual generado localmente.
- Validar envíos y publicaciones con `dryRun`, sin realizar la acción externa.

## Hallazgos de la revisión

La implementación anterior no coincidía con la UI real de WhatsApp Desktop:

1. Recorría solo 18 niveles del árbol UIA, pero la lista actual aparece después
   del nivel 25.
2. Buscaba conversaciones como `ListItem`; WhatsApp 2.2627.101.0 las expone
   como `DataItem` dentro de `Chat list`.
3. `whatsapp_web` estaba agregado a la detección, pero quedaba excluido en la
   validación final.
4. Un indicador `Read` de cualquier mensaje podía producir una verificación
   falsa.
5. El endpoint devolvía `ok: true` aunque no confirmara la nueva burbuja.
6. Solo existían `/whatsapp/contacts` y `/whatsapp/reply`.
7. Start Talk usa una ventana `topmost` que podía cubrir los controles de
   WhatsApp. El adapter ahora la minimiza solo durante la operación y la
   restaura siempre, incluso si la automatización devuelve un error.

Esos problemas quedaron corregidos. La verificación de texto compara la
cantidad de burbujas salientes exactas antes y después del envío.

## Endpoints

### Buscar contactos

`POST /whatsapp/contacts`

```json
{
  "query": "Sandra",
  "limit": 20,
  "unreadOnly": false,
  "includePreviews": true,
  "window": "whatsapp"
}
```

`query` es opcional. Cuando se incluye, el adapter usa el buscador propio de
WhatsApp y evita resolver un contacto por el texto del último mensaje.

### Leer mensajes

`POST /whatsapp/messages`

```json
{
  "contact": "Sandra Patricia",
  "limit": 20
}
```

Devuelve `incoming`/`outgoing`, remitente, contenido, hora y `sent`,
`delivered` o `read` cuando WhatsApp expone ese dato. Abrir la conversación
puede marcar mensajes pendientes como leídos.

### Enviar texto o archivos

`POST /whatsapp/reply`

```json
{
  "contact": "Sandra Patricia",
  "message": "Aquí estoy",
  "dryRun": true
}
```

Para un adjunto:

```json
{
  "contact": "Sandra Patricia",
  "mediaPath": "C:\\Users\\me\\Pictures\\foto.jpg",
  "message": "Mira esta foto",
  "dryRun": true
}
```

`message` funciona como caption cuando existe `mediaPath`.

### Listar estados

`POST /whatsapp/statuses`

```json
{
  "limit": 40
}
```

Lista autores y horas sin abrir cada estado, por lo que no los marca como
vistos.

### Publicar un estado

`POST /whatsapp/status`

Texto:

```json
{
  "text": "Disponible hoy",
  "background": "#075E54",
  "dryRun": true
}
```

Foto o video:

```json
{
  "mediaPath": "C:\\Users\\me\\Pictures\\anuncio.jpg",
  "caption": "Nuevo anuncio",
  "dryRun": true
}
```

WhatsApp Desktop abre el selector nativo de archivos. Para texto, Lumina crea
temporalmente una imagen vertical, la publica y elimina el archivo temporal.

## Seguridad

- Lumina Code pide confirmación antes de un envío real o una publicación real.
- Las lecturas y los `dryRun` no requieren confirmación.
- Un contacto ambiguo no se selecciona: el adapter devuelve candidatos.
- El log de auditoría guarda longitudes y resultados, no el contenido de los
  mensajes.
- Un resultado no se declara exitoso cuando la UI no pudo verificarlo.

## Verificación realizada

Se probó contra WhatsApp Desktop 2.2627.101.0 en la sesión Windows activa:

- Detección de `WhatsApp.Root.exe`.
- Lectura estructurada de conversaciones.
- Listado de estados sin abrirlos.
- Apertura de una conversación y lectura de mensajes entrantes/salientes.
- Reconocimiento de `read` en mensajes salientes.
- Compilación Python del adapter.
- `dryRun` HTTP de envío y publicación contra el bridge activo de `:8765`.
- Start Talk restaurado y activo después de cada operación.

En la medición final, listar contactos tomó aproximadamente 7.4 segundos y
leer tres mensajes recientes aproximadamente 13 segundos. Antes de eliminar
los recorridos UIA redundantes, esa lectura llegó a tardar cerca de 38
segundos.

No se envió un mensaje real ni se publicó un estado real durante esta revisión.
Esas acciones requieren contenido y destinatario explícitos del usuario.

## Pruebas

Desde `lumina-windows-bridge`:

```powershell
npm run typecheck
npm test
npm run test:whatsapp
```

Desde `Lumina-Code\continue-upstream`:

```powershell
npm run tsc:check
npx vitest run core/tools/implementations/luminaWindowsBridge.vitest.ts
```

## Archivos

- `openclaw-windows-bridge-lab/lumina-windows-bridge/sidecars/whatsapp.py`
- `openclaw-windows-bridge-lab/lumina-windows-bridge/src/server.ts`
- `Lumina-Code/continue-upstream/core/luminaBridge/client.ts`
- `Lumina-Code/continue-upstream/core/tools/definitions/luminaWindowsBridge.ts`

La copia bajo `Lumina_PC/apps/lumina-windows-bridge` apunta a estos mismos
archivos, por lo que no existe una segunda implementación divergente.

## Límites conocidos

- WhatsApp puede cambiar nombres o estructura UIA en una actualización futura.
- Leer una conversación puede marcarla como leída.
- El soporte de WhatsApp Desktop fue validado en vivo; PWA y Phone Link quedan
  implementados como fallback, pero requieren una prueba E2E separada.
- Llamadas, administración de grupos, canales, bloqueos y eliminación de
  mensajes no se automatizan todavía porque son acciones de mayor riesgo y no
  formaban parte del flujo solicitado.
