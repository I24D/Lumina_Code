# Workspace unificado de Lumina Code

Lumina Code mantiene una sola interfaz y una sola arquitectura de ejecución.
La evolución visual inspirada por Lumina-Openclaw se implementa directamente
en `continue-upstream/gui`; no se monta la UI de otro repositorio, no existe un
`iframe` y no se duplica `continue-upstream/core`.

## Límites arquitectónicos

| Responsabilidad | Ubicación que sigue siendo canónica |
| --- | --- |
| Interfaz React, chat y navegación | `continue-upstream/gui` |
| Agente, sesiones, voz, scheduler y permisos | `continue-upstream/core` |
| VS Code, Secret Storage y procesos nativos | `continue-upstream/extensions/vscode` |
| Orbe nativo de Start Talk | `Start-talk` |

El sistema visual adapta la jerarquía, navegación, tarjetas, estados y
comportamiento responsive de Lumina-Openclaw a las variables de tema de VS Code.
La implementación sigue siendo React y reutiliza los componentes funcionales de
Continue/Lumina; no incorpora el runtime Lit ni el Gateway de Openclaw.

## Superficies absorbidas

| Concepto de workspace | Superficie de Lumina Code | Backend real |
| --- | --- | --- |
| Chat y sesiones recientes | Chat, sidebar e Historial | History Manager y Redux de sesión |
| Dashboard, tareas y workboard | Panel de Trabajo | `WorkboardService`, plan del agente, metas, runtime y estadísticas |
| Revisiones | Recorrido de Cambios | diff del IDE y estados Apply |
| Automations | Trabajo Programado | `ScheduledTaskService` persistente |
| Usage | Uso y métricas | base de datos de devdata/tokens |
| Memory/context | Conocimiento e Indexing | reglas, skills, configs e indexación |
| Apps/plugins/channels | Conexiones | modelos, MCP, Start Talk y runtime |
| Security/approvals | Privacidad y Trabajo | políticas de capacidades y aprobaciones |
| Talk | Configuración de Start Talk | core de voz y VS Code Secret Storage |
| Logs/debug/infrastructure | Runtime y diagnóstico | estado de componentes y registros del host |

Los alias `/sessions`, `/usage`, `/automations`, `/workboard`,
`/settings/model-providers`, `/settings/mcp`, `/settings/memory`,
`/settings/security`, `/settings/talk`, `/settings/infrastructure`, `/logs` y
`/debug` conducen a esas superficies dentro del mismo router React.

## Chat evolucionado

El hilo usa un ancho máximo legible en ventanas grandes y conserva todo el
ancho disponible en el sidebar de VS Code. El compositor mantiene TipTap,
contexto `@`, comandos `/`, selector de modelo, modos, imágenes, Start Talk y
herramientas.

Durante un stream, el compositor principal permanece editable. Enviar otro
prompt lo coloca en una cola visible y cancelable. Al terminar la respuesta,
el siguiente elemento usa el mismo `streamResponseThunk`; por ello respeta el
modelo, contexto, permisos y flujo de herramientas normal. La cola se descarta
al cambiar de sesión para impedir que una instrucción termine en otra
conversación.

## Configuración y secretos

`startTalk/getConfigStatus` solo devuelve estado, modelo, nivel de pensamiento,
voz y origen de la configuración. Nunca devuelve la API key.
`startTalk/configure` acepta una clave nueva desde el webview y el core la entrega
al almacén del host. En VS Code se persiste mediante `ExtensionContext.secrets`.
Un `.env` del workspace conserva prioridad para permitir configuraciones
reproducibles sin cambiar el comportamiento existente.

## Protección y pruebas

- Vite convierte en error cualquier aviso de módulo Node externalizado para el
  navegador, evitando la causa conocida de pantallas negras.
- Las pruebas cubren navegación, paleta, sesiones recientes, cola, estado del
  runtime y configuración segura de Start Talk.
- `tsc:check` se ejecuta en GUI y core; la extensión se valida además con
  `esbuild` antes de probar el Development Host.

Cuando se absorba otra capacidad del ecosistema Lumina, debe integrarse en estas
carpetas canónicas y conectar una operación real. Una tarjeta sin backend o una
segunda UI no se consideran una implementación terminada.
