# OpenClaw Windows Bridge Lab — registro cerrado

Este laboratorio probó `openclaw-windows-node` como puente de capacidades
nativas de Windows. **El experimento terminó y su código ya no está aquí**: lo
que quedaba era una copia congelada del bridge (14/08/2026) sin `node_modules`
ni `.venv`, incapaz de arrancar, y unos scripts que apuntaban a
`C:\I24D_WhatsApp\`, una ruta que dejó de existir al mover el repo. Mantener dos
copias del mismo `server.ts` solo servía para que alguien editara la que no era.

El bridge vivo — el único — es `Lumina_PC/apps/lumina-windows-bridge`, y se
arranca como documenta `Run-lumina-code.md`.

> Nota histórica: la versión anterior de este documento decía que
> `Lumina_PC/apps/lumina-windows-bridge` era un *junction* a esta carpeta. Eso
> fue cierto en el layout viejo (`C:\I24D_WhatsApp`) y dejó de serlo con la
> mudanza: al comprobarlo, ambas eran carpetas reales e independientes.

## Lo que se decidió

- OpenClaw sigue siendo la UI/runtime principal.
- El companion de Windows se usa como puente de capacidades nativas, no como
  segunda UI de chat.
- No absorber una UI de chat duplicada.
- Probar MCP en local antes de emparejar por gateway.

## Lo que quedó demostrado

1. `winnode --list-tools` devuelve herramientas reales desde el Tray.
2. `system.which` resuelve rutas de binarios locales por MCP.
3. `tts.status` reporta el TTS de Windows listo.
4. `tts.speak` funciona con la voz femenina `Microsoft Zira`.
5. `system.notify` envía una notificación de Windows por MCP y por Gateway.
6. `screen.snapshot` devuelve un PNG real por MCP y por Gateway.
7. `camera.list` ve la `Integrated Webcam` por MCP y por Gateway.
8. Gateway Node Mode quedó emparejado, aprobado y conectado como
   `Windows Node (LUMINA)`.

## Lo que quedó pendiente a propósito

1. `camera.snap` no se ejecutó: habría guardado una foto real de la webcam.
2. `camera.snap`, `camera.clip`, `screen.record` y `tts.speak` existen por MCP
   local pero no están anunciados en la superficie aprobada del Gateway.
3. Los logs mostraban un aviso de ACL en el token MCP. Aceptable para trabajo de
   laboratorio; hay que resolverlo antes de usar esto como perfil de producción.
