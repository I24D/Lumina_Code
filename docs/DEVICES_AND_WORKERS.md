# Dispositivo local, workers y operaciones

Lumina Code muestra el inventario real del runtime en **Ajustes → Runtime y
diagnóstico**. La fuente de verdad sigue siendo el supervisor de la extensión;
no existe un segundo daemon dentro de la GUI.

## Inventario

El estado contiene:

- identificador estable de la máquina proporcionado por VS Code;
- nombre del host, plataforma y arquitectura;
- workers de Lumina Core, Windows Bridge y Model Router;
- endpoint, requisito, estado y hora del último sondeo de cada worker;
- si el runtime es administrado por esta instancia de Lumina Code.

El heartbeat de la extensión declara un `deviceId`, un `workerId`, capacidades y
`transport: local`. También declara `remoteOperations: false`, evitando que un
backend interprete un heartbeat como autorización para controlar la máquina.

## Reinicio seguro

El botón **Reiniciar workers administrados** solo aparece cuando esta extensión
es dueña del proceso. Exige dos clics, registra la aprobación en la auditoría y:

1. detiene el árbol de procesos administrado;
2. comprueba que los tres endpoints hayan liberado sus puertos;
3. si siguen activos, aborta para no crear un runtime duplicado;
4. inicia el supervisor normal y devuelve un estado nuevo.

Este orden cierra la carrera que podía producir `EADDRINUSE` al iniciar otro
Windows Bridge sobre el puerto 8765.

## Operaciones remotas

La build actual no abre un listener remoto y no acepta workers externos. La UI
lo expresa como `remoteExecution: false`; no presenta una tarjeta ficticia como
si existiera emparejamiento. Para habilitar control remoto en el futuro será
obligatorio añadir transporte autenticado, identidad de dispositivo, revocación,
expiración y aprobación local por operación. Hasta que todo ese contrato exista,
el comportamiento seguro y funcional es local únicamente.
