# Flujos avanzados del agente de Lumina Code

Esta guía describe las funciones incorporadas en la interfaz, su relación con el runtime y los límites que evitan ejecuciones accidentales. Todas se descubren escribiendo `/` en el editor del chat.

## Session Goals (`/goal`)

El diálogo permite definir una meta y un máximo de turnos. Después de cada respuesta correcta, Lumina Code pide a una llamada de modelo separada un veredicto estructurado. El runtime —no el modelo— incrementa el contador y aplica el límite.

El ciclo termina cuando la meta se completa, se bloquea, alcanza su límite, el usuario la cancela, cambia de sesión o falla una respuesta. Un stream fallido no se considera progreso y no se entrega al juez. La meta puede verse junto con el consumo de turnos en `/work`.

## Sesión desde GitHub (`/github`)

Acepta URLs completas de `github.com` para issues y pull requests. La extensión obtiene el título, cuerpo y comentarios; para un PR añade archivos modificados y revisiones. Luego abre una sesión nueva con ese contenido preparado en el editor.

La preparación no pulsa **Enviar** ni ejecuta herramientas. El usuario conserva la oportunidad de revisar, editar o cancelar el prompt.

Los repositorios públicos funcionan sin credencial, sujetos al límite anónimo de GitHub. Para repositorios privados o límites mayores, define de forma privada una de estas variables:

```dotenv
GITHUB_TOKEN=<token personal de GitHub>
# Alias admitido por el entorno de desarrollo de Lumina:
I24D_GITHUB=<token personal de GitHub>
```

No versiones el archivo `.env` ni copies tokens en capturas, issues o registros.

## Recorrido de cambios (`/changes`)

La vista consulta el diff Git del workspace y lo separa en archivos y bloques. Muestra progreso, estadísticas de líneas, navegación al archivo y acciones de aceptar o rechazar cuando el cambio pertenece al estado de aplicación pendiente de la sesión.

Esta vista no modifica cambios Git arbitrarios ni hace commits. Su objetivo es revisar con atención un conjunto grande sin perder la posición.

## Panel de trabajo (`/work`)

Reúne en una sola pantalla:

- sesión activa y modo de trabajo;
- workboard durable con columnas `backlog`, lista, en curso, revisión,
  bloqueada y terminada;
- alta, movimiento y borrado de tarjetas, prioridad, vínculo a la sesión y
  actividad reciente persistida;
- plan efímero del agente, separado deliberadamente del trabajo durable;
- metas activas y consumo de turnos;
- aprobaciones pendientes;
- tareas del runtime y su estado;
- sesiones recientes y tokens conocidos.

Cuando un proveedor no ofrece precios fiables —por ejemplo, un modelo cloud sin tabla local verificable— la interfaz indica que el coste no está disponible en vez de inventar una cifra.

Las tarjetas se guardan atómicamente en
`~/.continue/lumina-workboard.json`. El workboard sobrevive a cambios de chat y
reinicios; el plan del agente no, porque sus pasos solo son válidos dentro del
contexto de la conversación que los produjo.

## Trabajo programado (`/schedule`)

Permite crear ejecuciones únicas, diarias, semanales y expresiones cron de cinco campos. Cada tarea puede ejecutar un solo prompt o convertirlo en una Session Goal con un límite entero de 1 a 50 turnos.

El scheduler persiste en el directorio global de Lumina como `lumina-scheduled-tasks.json`, recupera ejecuciones interrumpidas y conserva un historial acotado. La interfaz permite pausar, editar, eliminar con confirmación, ejecutar ahora y revisar errores.

Una tarea programada no es un servicio cloud: necesita que el host de la extensión esté ejecutándose para reclamar el trabajo. Los permisos de herramientas, aprobaciones y políticas del agente siguen siendo los mismos que en una sesión iniciada manualmente.

## Protección del webview

La GUI se compila para navegador y no puede importar módulos de Node como `fs`, `path` o bindings nativos. El build de Vite convierte cualquier aviso `externalized for browser compatibility` en un error, cerrando la causa conocida de pantallas negras antes de empaquetar la extensión.

## Verificación para colaboradores

Desde `continue-upstream`:

```powershell
cd core
npm run tsc:check
npm run vitest -- scheduler goals startTalk github

cd ..\gui
npm run tsc:check
npm test
npm run build

cd ..\extensions\vscode
npm run tsc:check
npm run esbuild
```

Las pruebas automatizadas cubren persistencia y recuperación del scheduler, preparación de GitHub, parsing de diffs, panel de trabajo, comandos del editor, el ciclo de metas con dos turnos reales simulados y las rutas deterministas de Start Talk. La selección física de micrófono, permisos de Windows y audio del dispositivo deben validarse además en un Extension Development Host real.
