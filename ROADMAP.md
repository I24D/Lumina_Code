# Roadmap público de Lumina Code

Última actualización: agosto de 2026.

Este roadmap describe la preparación de Lumina Code para una comunidad pública. No representa una promesa de fechas. Cada fase se considera completa cuando otra persona puede reproducir y verificar su resultado.

## Principio de publicación

El proyecto no publicará un árbol de código solamente para poder decir que es open source. La meta es ofrecer una base que pueda clonarse, configurarse, compilarse, probarse y comprenderse sin depender de rutas privadas, credenciales o conocimiento exclusivo del autor.

## Fase 0: Base legal y comunitaria

**Estado: completada**

- [x] Publicar Apache License 2.0.
- [x] Acreditar el trabajo derivado de Continue mediante `NOTICE`.
- [x] Definir el estado real del proyecto en el README.
- [x] Añadir guía de contribución, seguridad y conducta.
- [x] Preparar plantillas para issues y pull requests.

## Fase 1: Saneamiento del árbol público

**Estado: en progreso**

- [x] Publicar un snapshot inicial del código fuente.
- [ ] Separar infraestructura privada y configuración local.
- [ ] Eliminar credenciales, identificadores, rutas absolutas y artefactos generados.
- [ ] Crear `.env.example` documentado y seguro.
- [ ] Mantener atribuciones y licencias de terceros por componente.
- [ ] Definir límites claros entre Lumina Code, OpenClaw y servicios externos.
- [ ] Revisar el historial que formará parte de la publicación comunitaria.

## Fase 2: Extensión reproducible y funcional

**Estado: completada**

- [x] Publicar la extensión de VS Code y sus dependencias necesarias.
- [x] Documentar instalación de Node.js, VS Code y toolchains opcionales.
- [x] Documentar generación e instalación manual del VSIX para Windows x64.
- [x] Proporcionar un launcher de desarrollo sin rutas específicas del autor.
- [x] Añadir verificaciones de módulos nativos y errores accionables al launcher.
- [x] Publicar pruebas enfocadas para los contratos compartidos.
- [x] Validar el flujo completo de compilación, activación y empaquetado en Windows x64.

## Fase 3: Start Talk y runtime Windows

**Estado: en progreso**

- [ ] Documentar el protocolo entre la extensión y el orbe nativo.
- [x] Documentar requisitos y comandos de build para Tauri/Rust.
- [ ] Validar la compilación de Start Talk desde un equipo Windows limpio.
- [ ] Estabilizar reconexión, dispositivos de audio y estados de error.
- [ ] Documentar permisos y límites del Windows bridge.
- [ ] Añadir pruebas de acciones permitidas y bloqueadas.

## Fase 4: Distribución y actualizaciones

**Estado: futura**

- [ ] Publicar un VSIX firmado o distribuir la extensión mediante Marketplace.
- [ ] Crear notas de release y matriz de compatibilidad.
- [ ] Habilitar un flujo de actualización verificable.
- [ ] Recopilar telemetría únicamente si es explícita, opcional y documentada.
- [ ] Priorizar problemas reportados por los primeros colaboradores.

## Fase 4A: Flujos avanzados del agente

**Estado: completada**

- [x] Sustituir el `window.prompt` de Session Goals por un diálogo propio del webview.
- [x] Probar una meta con continuación real, veredicto separado y terminación automática.
- [x] Preparar sesiones desde issues y pull requests de GitHub sin ejecución automática.
- [x] Añadir un recorrido guiado de cambios por archivo y bloque de diff.
- [x] Añadir un panel de trabajo con sesiones, metas, aprobaciones, tareas y tokens.
- [x] Añadir trabajos persistentes únicos, diarios, semanales y cron con historial de ejecuciones.
- [x] Hacer fallar el build si un módulo de Node se filtra al bundle del navegador.
- [x] Reparar el foco y la ejecución de acciones del menú `/` del chat.

## Fase 5: Community beta

**Estado: futura**

- [ ] Abrir módulos etiquetados como `good first issue`.
- [ ] Publicar una política de compatibilidad y versionado.
- [ ] Mantener documentación de arquitectura y decisiones técnicas.
- [ ] Ampliar pruebas de accesibilidad, internacionalización y seguridad.
- [ ] Preparar el camino hacia una primera release estable.

## Áreas donde la comunidad puede ayudar ahora

- mejorar claridad, traducción y accesibilidad de la documentación;
- proponer casos de uso con criterios de aceptación verificables;
- revisar el modelo de amenazas de herramientas con acceso al sistema;
- diseñar planes de prueba para voz, memoria, MCP y Windows;
- señalar atribuciones o licencias de terceros que deban conservarse;
- participar en Issues y Discussions con observaciones concretas.

El alcance puede cambiar a medida que la arquitectura se estabiliza. Los cambios relevantes se documentarán aquí y en las notas de cada release.
