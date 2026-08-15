<p align="center">
  <img src="media/lumina-icon.png" alt="Lumina Code" width="128">
</p>

<h1 align="center">Lumina Code</h1>

<p align="center">
  <strong>IA que trabaja a tu lado.</strong><br>
  <em>Windows-first AI coding agent with voice, memory, MCP, and responsible tools.</em>
</p>

> [!IMPORTANT]
> Lumina Code se encuentra en desarrollo activo. Los VSIX generados desde este repositorio son builds experimentales para colaboradores; todavía no existe una release estable ni una publicación oficial en Marketplace.

## Capacidades en desarrollo

- conversación y trabajo asistido sobre código dentro de VS Code;
- voz nativa mediante Start Talk;
- memoria y continuidad entre sesiones;
- modelos locales o remotos según la configuración;
- herramientas para archivos, terminal y contexto del proyecto;
- interoperabilidad mediante MCP y puentes modulares.

## Instalación para colaboradores

La extensión incluye componentes nativos y no puede empaquetarse correctamente con un `vsce package` aislado. Start Talk debe existir antes del preempaquetado.

Consulta la guía oficial del repositorio:

- [Instalación y generación del VSIX](https://github.com/I24D/Lumina_Code/blob/main/docs/INSTALLATION_AND_VSIX.md)
- [Estado del proyecto](https://github.com/I24D/Lumina_Code#estado-del-proyecto--project-status)
- [Contribuir](https://github.com/I24D/Lumina_Code/blob/main/CONTRIBUTING.md)
- [Reportar un problema](https://github.com/I24D/Lumina_Code/issues/new/choose)

Una vez abierta o instalada la extensión, Start Talk debe iniciarse con el comando **Lumina Code: Start Talk (orbe de escritorio)**. Abrir el ejecutable directamente omite el puente de sesión creado por la extensión.

## Seguridad

Una extensión de VS Code posee los mismos permisos del editor. Revisa el commit que vas a compilar, no agregues secretos al árbol y utiliza únicamente VSIX creados por ti o provenientes de una release verificable. Consulta la [política de seguridad](https://github.com/I24D/Lumina_Code/blob/main/SECURITY.md).

## Atribución

Lumina Code está basado en parte en [Continue](https://github.com/continuedev/continue), distribuido bajo Apache License 2.0. Lumina Code contiene modificaciones independientes y no está respaldado ni afiliado oficialmente con Continue Dev, Inc. Consulta `NOTICE` para la atribución incluida en el paquete.

## Licencia

[Apache License 2.0](LICENSE.txt)
