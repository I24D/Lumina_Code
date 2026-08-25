# Plugins locales y Skill Workshop

Lumina Code integra plugins y habilidades en el `core` y en la única GUI de la
extensión. No abre una segunda interfaz ni importa un runtime JavaScript desde
una carpeta de terceros.

## Skill Workshop

Abre **Ajustes → Skills** y pulsa `+` para crear una habilidad. El taller permite:

- elegir si vive en el proyecto (`.continue/skills`) o en el perfil global;
- validar nombre, descripción y procedimiento antes de escribir el archivo;
- editar revisiones existentes sin reemplazos implícitos;
- conservar frontmatter YAML válido aunque la descripción tenga dos puntos,
  almohadillas o comillas.

El agente usa exactamente el mismo servicio cuando llama a `create_skill`, por
lo que una habilidad aprendida y una creada desde la interfaz reciben la misma
validación y telemetría.

## Formato de plugin

Un plugin local es una carpeta bajo `.continue/plugins` del proyecto o bajo el
directorio global de Continue. Debe incluir un `plugin.json`:

```json
{
  "id": "release-pack",
  "name": "Release Pack",
  "version": "1.0.0",
  "description": "Procedimientos reproducibles para publicar una versión"
}
```

Las habilidades se descubren recursivamente en esa misma carpeta:

```text
.continue/plugins/release-pack/
├── plugin.json
└── skills/
    └── verify-release/
        └── SKILL.md
```

El catálogo aparece al final de **Ajustes → Skills**. Un plugin desactivado
permanece instalado, pero sus `SKILL.md` dejan de entrar al contexto del agente.
El estado se guarda de forma atómica en `lumina-plugin-state.json`.

## Límite de seguridad

El catálogo es deliberadamente declarativo: descubre manifiestos y aporta
habilidades, pero nunca ejecuta JavaScript arbitrario desde la carpeta del
plugin. Una integración que necesite procesos, red o herramientas debe usar un
servidor MCP configurado en Lumina Code, donde siguen aplicando sus políticas de
permisos y aprobaciones.
