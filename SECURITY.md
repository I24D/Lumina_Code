# Política de seguridad

Lumina Code interactúa con código, terminales, modelos de IA y herramientas del sistema. Agradecemos los reportes responsables que ayuden a proteger a sus usuarios y colaboradores.

## Versiones soportadas

Todavía no existe una release pública estable. La rama `main` y los commits históricos deben considerarse software en desarrollo y no están recomendados para uso de producción.

Esta sección se actualizará con una matriz de versiones cuando se publique la primera developer preview.

## Reportar una vulnerabilidad

No abras un issue público para una vulnerabilidad ni incluyas una prueba que exponga credenciales, datos personales o acceso a un sistema.

Envía el reporte a:

**lessamtv@gmail.com**

Usa el asunto `Lumina Code Security Report` e incluye, cuando sea posible:

- componente y versión o commit afectado;
- impacto potencial;
- pasos mínimos de reproducción;
- condiciones necesarias para explotar el problema;
- mitigación sugerida;
- cualquier evidencia ya saneada.

Nunca envíes tokens, contraseñas, archivos `.env` completos, datos de conversaciones o información personal de terceros.

## Qué esperar

El proyecto intentará:

1. confirmar la recepción dentro de siete días;
2. evaluar impacto y reproducibilidad;
3. mantener comunicación mientras se prepara una corrección;
4. coordinar una divulgación responsable cuando corresponda;
5. reconocer al investigador, salvo que prefiera permanecer anónimo.

Los tiempos pueden variar porque el proyecto se mantiene de forma independiente, pero los reportes que impliquen ejecución de comandos, exposición de secretos o acceso no autorizado tendrán prioridad.

## Áreas de especial interés

- inyección o ejecución de comandos no autorizados;
- evasión de confirmaciones o políticas de herramientas;
- exposición de credenciales o memoria privada;
- acciones Windows fuera de la aplicación o contexto permitido;
- vulnerabilidades en puentes MCP o autenticación;
- escritura arbitraria de archivos o escalamiento de privilegios;
- filtración de contenido a proveedores de modelos no seleccionados;
- registros que capturen mensajes, tokens o datos personales.

## Fuera de alcance

- ataques de denegación de servicio que requieran tráfico destructivo;
- ingeniería social contra el mantenedor o colaboradores;
- reportes automatizados sin evidencia de impacto;
- vulnerabilidades exclusivas de dependencias sin demostrar cómo afectan a Lumina Code;
- commits históricos que ya no formen parte de una versión publicada, salvo que revelen secretos aún vigentes.

Gracias por ayudar a que Lumina Code avance con seguridad y transparencia.
