# Doctor, backup y actualizaciones

La pestaña **Ajustes → Runtime** reúne las operaciones locales de mantenimiento
de Lumina Code. Estas funciones viven en el host de la extensión existente; no
añaden un daemon ni una interfaz paralela.

## Lumina Doctor

Doctor comprueba de forma explícita:

- plataforma, arquitectura y versión de Node del Extension Host;
- bundle HTML de la GUI;
- bindings nativos de SQLite y LanceDB;
- ejecutable nativo de Start Talk;
- presencia de una configuración global de Gemini, sin leer ni devolver la
  clave;
- disponibilidad real de Core, Windows Bridge y Model Router;
- escritura del almacenamiento local de la extensión.

Cada resultado es `correcto`, `aviso` o `fallo` e incluye una reparación
concreta cuando aplica. Un componente opcional apagado no se presenta como
fallo obligatorio.

## Backup seguro

El backup JSON versionado puede incluir:

- memoria, experiencias y tareas del agente;
- workboard y trabajos programados;
- políticas de canales y permisos;
- opciones no secretas de Start Talk e historial de Quick Edit;
- reglas, skills y manifiestos de plugins bajo `.continue` en los workspaces
  abiertos.

Secret Storage, claves API, tokens, contraseñas, PID, autorizaciones pendientes
y el historial de auditoría quedan excluidos. El contenido también pasa por una
redacción de patrones de credenciales y límites de tamaño.

La restauración acepta solamente el esquema conocido, IDs persistentes
permitidos y rutas bajo `.continue/rules`, `.continue/skills` o
`.continue/plugins`. Rechaza `..`, enlaces simbólicos durante la exportación,
archivos excesivos y claves de estado desconocidas. Antes de sobrescribir pide
confirmación modal y recarga VS Code inmediatamente para que core vuelva a leer
los snapshots restaurados.

## Actualizaciones

La comprobación consulta `releases/latest` del repositorio oficial
`I24D/Lumina_Code`, valida que el enlace recibido siga perteneciendo a ese
repositorio y compara versiones semánticas. Si hay una versión nueva, abre su
página para revisión manual. No descarga, ejecuta ni instala código por sí sola.

Mientras no exista una release pública, la interfaz lo indica y mantiene el
flujo reproducible desde código fuente descrito en el README.
