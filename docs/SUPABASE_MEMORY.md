# Memoria local y Supabase opcional

Lumina Code siempre conserva la memoria del agente localmente. Supabase es una
réplica optativa para compartirla entre instalaciones del mismo usuario; una
caída, token vencido o proyecto sin configurar no desactiva la memoria local.

## Qué se conserva

El archivo `~/.lumina-code/agent-state/memory.json` contiene un snapshot
versionado con:

- experiencias verificables de herramientas;
- reflexiones derivadas de patrones repetidos;
- candidatos de habilidades reutilizables;
- tombstones de experiencias borradas, para que otra instalación no las
  resucite al sincronizar.

Las instalaciones antiguas que tengan `experiences.jsonl` se importan una vez
al nuevo snapshot. Los secretos no forman parte del snapshot ni se envían a la
GUI.

## Crear la tabla

Aplica la migración versionada en
`supabase/migrations/20260825154914_lumina_memory_sync.sql` a tu proyecto. La
migración:

- crea `public.lumina_memory_state` con clave compuesta por usuario y
  namespace;
- habilita Row Level Security;
- concede acceso Data API solo a `authenticated`, no a `anon`;
- limita SELECT, INSERT, UPDATE y DELETE a filas donde
  `auth.uid() = user_id`;
- incluye tanto `USING` como `WITH CHECK` para UPDATE.

Esto también cubre proyectos nuevos donde las tablas ya no se exponen
automáticamente a Data API: los grants requeridos están en la misma migración.

## Configuración

Copia solo las variables necesarias desde [`.env.example`](../.env.example):

```dotenv
LUMINA_SUPABASE_URL=https://your-project.supabase.co
LUMINA_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
LUMINA_SUPABASE_ACCESS_TOKEN=<JWT de un usuario autenticado>
LUMINA_SUPABASE_MEMORY_TABLE=lumina_memory_state
LUMINA_SUPABASE_MEMORY_NAMESPACE=default
```

El access token debe pertenecer al usuario cuya memoria se sincroniza. Al
vencer, la vista **Conocimiento** mostrará el error de Supabase y seguirá
trabajando localmente; actualiza el token antes de volver a sincronizar.

No uses `service_role` ni una clave `sb_secret_...` en esta configuración. La
publishable key identifica el proyecto, mientras el JWT de usuario permite que
RLS aplique la propiedad de cada fila.

## Conflictos y borrado

La sincronización primero descarga, fusiona por identificador y fecha, y luego
hace un upsert del snapshot combinado. Las experiencias son inmutables; un
tombstone posterior prevalece sobre una experiencia anterior. El namespace
permite mantener memorias separadas para perfiles distintos dentro de la misma
cuenta.

La vista **Conocimiento** permite buscar, olvidar una experiencia, borrar toda
la memoria mediante confirmación de dos pasos y lanzar una sincronización
manual. Borrar localmente crea tombstones para propagar el olvido en el próximo
sync.
