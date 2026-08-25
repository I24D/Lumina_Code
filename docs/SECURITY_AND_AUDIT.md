# Seguridad, secretos, aprobaciones y auditoría

Lumina Code aplica las decisiones sensibles en el backend y conserva una
traza local verificable. La pantalla **Ajustes → Privacidad** permite revisar
permisos y los eventos recientes sin abrir archivos internos.

## Permisos y aprobaciones

- Cada capacidad tiene política `ask`, `allow` o `block`.
- Acciones irreversibles, como controlar el equipo o responder mensajes, no
  admiten una concesión permanente: un archivo de permisos editado a mano se
  normaliza de nuevo a `ask`.
- Las herramientas registran si fueron aprobadas por el usuario, autorizadas
  automáticamente, rechazadas o bloqueadas por política.
- El backend registra además inicio, resultado y duración de las herramientas
  que ejecuta. Los argumentos completos no se guardan en la auditoría.

Los permisos se escriben mediante reemplazo atómico en
`~/.continue/lumina-permissions.json` y, donde el sistema lo permite, reciben
modo de archivo privado.

## Secretos

En VS Code, las claves manejadas por el host se cifran con AES-256-GCM. La clave
de cifrado vive en `vscode.SecretStorage`; los valores autenticados viven en el
almacenamiento global de la extensión y se reemplazan mediante archivo temporal
con recuperación ante fallo.

Los contratos de estado —por ejemplo el de Start Talk— informan si una clave
está configurada y cuál es su origen, pero nunca devuelven su valor a la GUI.
Los archivos `.env` continúan excluidos de Git y del índice de contexto.

## Registro local

La auditoría se guarda como JSONL en
`~/.continue/lumina-security-audit.jsonl`. Antes de escribir:

1. campos cuyos nombres parecen claves, tokens, contraseñas o cabeceras de
   autorización se sustituyen por `[omitted]`;
2. tokens de proveedores, JWT, claves privadas, cadenas de conexión y otras
   formas reconocibles se enmascaran;
3. textos, claves y cantidad de detalles se limitan para impedir que el log se
   convierta en un volcado accidental;
4. al superar el límite de tamaño se conservan únicamente los 500 eventos más
   recientes mediante un reemplazo atómico.

El usuario puede borrar el registro desde la GUI, pero la acción exige dos
clics. Un error de auditoría nunca interrumpe la operación que se estaba
protegiendo.
