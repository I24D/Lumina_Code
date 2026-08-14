# Contribuir a Lumina Code

Gracias por querer mejorar Lumina Code. El proyecto se encuentra en desarrollo activo. Ya existe un snapshot público del código y se está trabajando para convertirlo en una build reproducible y fácil de configurar. Las contribuciones responsables son bienvenidas desde ahora.

## Antes de comenzar

1. Lee el [Código de Conducta](CODE_OF_CONDUCT.md).
2. Revisa los [issues existentes](https://github.com/I24D/Lumina_Code/issues) y las [Discussions](https://github.com/I24D/Lumina_Code/discussions).
3. No publiques credenciales, datos personales, conversaciones privadas ni registros sensibles.
4. Para vulnerabilidades, utiliza el proceso privado descrito en [SECURITY.md](SECURITY.md).

## Estado actual de las contribuciones

Durante la estabilización del snapshot público, se aceptan especialmente:

- reportes de documentación incorrecta o confusa;
- traducciones y mejoras de accesibilidad;
- propuestas de arquitectura y experiencia de usuario;
- casos de uso concretos y verificables;
- modelos de amenazas y observaciones de seguridad;
- planes de prueba para Windows, VS Code, voz, memoria y MCP.

Los pull requests de código son bienvenidos cuando están vinculados a un issue y mantienen un alcance pequeño y verificable. Para cambios amplios, nuevas integraciones o decisiones de arquitectura, abre primero una Discussion. Algunos módulos todavía dependen de configuración no documentada y pueden requerir trabajo previo antes de aceptar cambios. Consulta [ROADMAP.md](ROADMAP.md) para conocer el avance.

## Reportar un problema

Un buen reporte permite reproducir el problema sin adivinar. Incluye:

- componente afectado;
- versión, commit o fecha observada;
- versión de Windows, VS Code y runtime relevante;
- pasos mínimos para reproducirlo;
- resultado esperado y resultado real;
- registros ya saneados, sin secretos ni información personal;
- capturas únicamente cuando no expongan datos sensibles.

Si estás describiendo un comportamiento de una build antigua, indícalo claramente. Los commits históricos no se consideran releases soportadas.

## Proponer una función

Explica primero el problema, no solo la solución. Una propuesta útil responde:

- ¿quién necesita esta capacidad?;
- ¿qué flujo actual resulta difícil o imposible?;
- ¿cómo se comprobaría que la mejora funciona?;
- ¿qué riesgos de privacidad, seguridad o accesibilidad introduce?;
- ¿existe una alternativa más pequeña?

Las funciones que ejecutan acciones sobre el sistema deben incluir límites, confirmaciones y una estrategia de auditoría.

## Flujo para pull requests

1. Abre o identifica un issue antes de comenzar un cambio considerable.
2. Comenta que deseas trabajar en él para evitar esfuerzos duplicados.
3. Crea una rama enfocada, por ejemplo `docs/installation-status` o `fix/voice-timeout`.
4. Mantén el cambio limitado a un objetivo verificable.
5. Añade o actualiza pruebas cuando exista código afectado.
6. Ejecuta las verificaciones documentadas por el módulo.
7. Abre el pull request y completa toda la plantilla.

No incluyas refactorizaciones amplias dentro de una corrección pequeña. Las propuestas de arquitectura deben discutirse primero.

## Estándares de calidad

Una contribución debería:

- explicar el comportamiento, no solamente la implementación;
- conservar la experiencia Windows-first del proyecto;
- evitar rutas absolutas y dependencias del equipo del autor;
- usar configuración mediante variables documentadas y ejemplos sin secretos;
- mantener acciones sensibles bajo políticas de mínimo privilegio;
- incluir mensajes de error útiles y registros que no expongan contenido privado;
- respetar accesibilidad, internacionalización y navegación por teclado;
- actualizar documentación y atribuciones cuando corresponda.

## Commits

Usa mensajes breves en modo imperativo. Ejemplos:

```text
Add contributor setup guide
Fix Start Talk reconnect timeout
Document Windows bridge permission boundary
```

No es obligatorio reescribir todo el historial antes de abrir un PR. La rama principal utiliza squash merge para mantener un historial legible.

## Lista de verificación del pull request

- [ ] El cambio está vinculado a un issue o explica por qué no lo necesita.
- [ ] No contiene secretos, identificadores personales ni rutas privadas.
- [ ] Incluye evidencia de validación adecuada al cambio.
- [ ] Añade pruebas o explica por qué no aplican.
- [ ] Actualiza documentación, ejemplos y atribuciones necesarias.
- [ ] Considera seguridad, privacidad y accesibilidad.
- [ ] Acepto que mi contribución se publique bajo Apache License 2.0.

## Licencia de las contribuciones

Al enviar una contribución, aceptas que se distribuya bajo la [Apache License 2.0](LICENSE), igual que el proyecto. Solo envía material que tengas derecho a aportar.

## English summary

Lumina Code now has a public development snapshot and is working toward a reproducible clean-machine build. Documentation, translation, UX, accessibility, tests, focused code fixes, architecture feedback, and responsible security input are welcome. Please start with an issue, discuss broad changes first, keep pull requests focused, never include secrets, and submit contributions under Apache License 2.0.
