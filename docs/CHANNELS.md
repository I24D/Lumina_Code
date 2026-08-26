# WhatsApp, Enlace móvil y contratos de canales

Lumina Code separa cada origen de mensajería y mantiene un contrato común de
consentimiento. La configuración vive en **Conexiones → Contratos de canales** y
se persiste en `~/.continue/lumina-channels.json`.

## Modos

- **Solo manual** (predeterminado): Lumina puede leer mediante su herramienta y
  puede proponer un envío en el chat, pero el envío espera un clic del usuario.
- **Sugerir borradores**: el monitor de notificaciones puede preparar un texto
  local únicamente para contactos incluidos explícitamente en la lista de
  confianza. El borrador aparece como aviso; no se envía.
- **Desactivado**: las herramientas del canal rechazan lectura y envío en el
  backend, no solo en la interfaz.

Los nombres confiables se comparan normalizando mayúsculas, espacios y acentos.
Una lista vacía no autoriza a nadie. Grupos, mensajes agregados y contenido
sensible continúan bloqueados por los clasificadores de WhatsApp y Enlace móvil.

## Garantía de envío

`reply` y `publish_status` llevan la marca backend
`requiresExplicitApproval`. La evaluación de herramientas aplica esa marca
antes de considerar **Full Access**, de modo que Full Access puede agilizar
tareas de programación pero no autoriza a Lumina a hablar en nombre del usuario.

El antiguo auto-responder en vivo fue retirado. El monitor de borradores ya no
contiene código que llame a `/whatsapp/reply` ni `/phone_link/reply`; las únicas
rutas de entrega son las herramientas normales y aprobadas del chat. Cada
aprobación, rechazo, bloqueo y ejecución queda en la auditoría redactada.

## Canales actuales

| Canal                     | Lectura                         | Envío                | Ingreso opcional                   |
| ------------------------- | ------------------------------- | -------------------- | ---------------------------------- |
| WhatsApp Desktop          | herramienta `lumina_whatsapp`   | aprobación explícita | borrador para contactos confiables |
| Enlace móvil / Phone Link | herramienta `lumina_phone_link` | aprobación explícita | borrador para contactos confiables |

La automatización usa el Windows Bridge local; no existe un relay público ni se
publican mensajes a un servidor de Lumina Code.
