/**
 * permissions.ts — Permisos de capacidades de Lumina Code.
 *
 * Qué es: el equivalente de los "permisos del sitio" de un navegador, pero
 * sobre las capacidades que Lumina tiene DE VERDAD. Micrófono, cámara,
 * pantalla, control del PC, mensajería, búsqueda web y contexto del sistema son
 * sensores y acciones con consecuencias reales, así que cada uno tiene una
 * política explícita y editable.
 *
 * Tres estados, igual que en el navegador:
 *   - `ask`   → pide autorización cada vez (predeterminado en lo delicado)
 *   - `allow` → concedido sin preguntar
 *   - `block` → denegado siempre, ni siquiera pregunta
 *
 * Se guarda aparte del config de Continue a propósito: una política de
 * privacidad no debe depender del esquema de configuración del editor ni
 * perderse si ese archivo se corrompe o se regenera.
 *
 * IMPORTANTE: esto no es solo UI. `resolvePolicy` se consulta en los puntos
 * donde la capacidad se ejerce de verdad (ver StartTalkManager), así que poner
 * algo en `block` lo apaga de hecho, no solo de cara al usuario.
 */
import fs from "node:fs";
import path from "node:path";

import {
  getContinueGlobalPath,
  setConfigFilePermissions,
} from "../util/paths.js";

export type PermissionPolicy = "ask" | "allow" | "block";

export type LuminaCapability =
  | "microphone"
  | "camera"
  | "screen"
  | "notifications"
  | "notificationReplies"
  | "webSearch"
  | "computerControl"
  | "systemContext"
  | "voiceMemory"
  | "telemetry";

/** Agrupación para que la UI no sea una lista plana de veinte filas. */
export type CapabilityGroup = "sensors" | "services" | "actions" | "data";

export interface CapabilityDefinition {
  id: LuminaCapability;
  group: CapabilityGroup;
  /** Etiqueta corta, en español, como en el resto de la UI de Start Talk. */
  label: string;
  /** Qué implica concederlo, en una frase. */
  description: string;
  /** Política de fábrica. */
  defaultPolicy: PermissionPolicy;
  /**
   * Capacidades donde `allow` no tiene sentido porque la acción es
   * irreversible o sale del equipo: la UI no ofrece esa opción.
   */
  askOnly?: boolean;
}

/**
 * El registro es la fuente de verdad: la UI se dibuja a partir de él, así que
 * añadir una capacidad aquí la hace aparecer sola en los ajustes.
 */
export const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: "microphone",
    group: "sensors",
    label: "Micrófono",
    description:
      "Permite que Start Talk escuche para conversar contigo. Sin esto, la voz no funciona.",
    defaultPolicy: "ask",
  },
  {
    id: "camera",
    group: "sensors",
    label: "Cámara",
    description:
      "Permite que Lumina vea a través de una cámara cuando tú lo activas.",
    defaultPolicy: "ask",
  },
  {
    id: "screen",
    group: "sensors",
    label: "Pantalla",
    description:
      "Permite compartir tu pantalla en vivo para que Lumina pueda ayudarte con lo que estás viendo.",
    defaultPolicy: "ask",
  },
  {
    id: "notifications",
    group: "services",
    label: "Notificaciones",
    description:
      "Deja que Lumina lea en voz alta las notificaciones de Windows que van llegando.",
    defaultPolicy: "ask",
  },
  {
    id: "notificationReplies",
    group: "actions",
    label: "Responder mensajes",
    description:
      "Permite responder mensajes de WhatsApp o Enlace Móvil por ti. Siempre pide confirmación hablada antes de enviar.",
    defaultPolicy: "ask",
    // Enviar un mensaje en tu nombre no se puede deshacer.
    askOnly: true,
  },
  {
    id: "webSearch",
    group: "services",
    label: "Búsqueda web",
    description:
      "Permite consultar internet para responder sobre precios, noticias u horarios. Tu consulta sale del equipo.",
    defaultPolicy: "allow",
  },
  {
    id: "computerControl",
    group: "actions",
    label: "Control del equipo",
    description:
      "Permite ejecutar tareas reales: editar código, abrir aplicaciones, usar la terminal y controlar Windows.",
    defaultPolicy: "ask",
    // Ejecutar acciones en el PC sin preguntar es la vía más directa a un
    // destrozo irreversible.
    askOnly: true,
  },
  {
    id: "systemContext",
    group: "data",
    label: "Estado del sistema",
    description:
      "Deja consultar fecha, zona horaria, red, batería y almacenamiento para responder con datos correctos.",
    defaultPolicy: "allow",
  },
  {
    id: "voiceMemory",
    group: "data",
    label: "Memoria de conversaciones",
    description:
      "Permite recordar lo hablado entre sesiones para no empezar de cero cada vez.",
    defaultPolicy: "allow",
  },
  {
    id: "telemetry",
    group: "data",
    label: "Telemetría anónima",
    description:
      "Envía estadísticas de uso sin contenido personal para detectar fallos.",
    defaultPolicy: "block",
  },
];

const CAPABILITY_IDS = new Set<string>(CAPABILITIES.map((c) => c.id));

export type PermissionMap = Partial<Record<LuminaCapability, PermissionPolicy>>;

function isPolicy(value: unknown): value is PermissionPolicy {
  return value === "ask" || value === "allow" || value === "block";
}

function permissionsFilePath(): string {
  return path.join(getContinueGlobalPath(), "lumina-permissions.json");
}

function persistPermissions(permissions: PermissionMap): void {
  const file = permissionsFilePath();
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(permissions, null, 2), "utf8");
  fs.renameSync(temporary, file);
  setConfigFilePermissions(file);
}

/** Políticas de fábrica, derivadas del registro. */
export function defaultPermissions(): PermissionMap {
  const defaults: PermissionMap = {};
  for (const capability of CAPABILITIES) {
    defaults[capability.id] = capability.defaultPolicy;
  }
  return defaults;
}

/**
 * Normaliza lo leído del disco: descarta capacidades desconocidas y valores
 * inválidos, y fuerza `ask` donde `allow` no está permitido. Un archivo tocado
 * a mano no puede conceder algo que la UI nunca ofrecería.
 */
export function sanitizePermissions(raw: unknown): PermissionMap {
  const result = defaultPermissions();
  if (!raw || typeof raw !== "object") {
    return result;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CAPABILITY_IDS.has(key) || !isPolicy(value)) {
      continue;
    }
    const capability = CAPABILITIES.find((c) => c.id === key)!;
    if (value === "allow" && capability.askOnly) {
      result[capability.id] = "ask";
      continue;
    }
    result[capability.id] = value;
  }
  return result;
}

let cache: PermissionMap | null = null;

/** Políticas actuales, cacheadas tras la primera lectura. */
export function getPermissions(): PermissionMap {
  if (cache) {
    return { ...cache };
  }
  try {
    const file = permissionsFilePath();
    if (fs.existsSync(file)) {
      cache = sanitizePermissions(JSON.parse(fs.readFileSync(file, "utf8")));
    } else {
      cache = defaultPermissions();
    }
  } catch {
    // Archivo ilegible o corrupto: se cae a los valores de fábrica en vez de
    // dejar la aplicación sin política ninguna.
    cache = defaultPermissions();
  }
  return { ...cache };
}

/** Política efectiva de una capacidad. */
export function resolvePolicy(capability: LuminaCapability): PermissionPolicy {
  return getPermissions()[capability] ?? "ask";
}

/** True cuando la capacidad NO está bloqueada (concedida o pendiente de pedir). */
export function isCapabilityAvailable(capability: LuminaCapability): boolean {
  return resolvePolicy(capability) !== "block";
}

/** True cuando puede ejercerse sin volver a preguntar. */
export function isCapabilityGranted(capability: LuminaCapability): boolean {
  return resolvePolicy(capability) === "allow";
}

/** Cambia una política y la persiste. Devuelve el mapa ya normalizado. */
export function setPermission(
  capability: LuminaCapability,
  policy: PermissionPolicy,
): PermissionMap {
  const next = sanitizePermissions({
    ...getPermissions(),
    [capability]: policy,
  });
  cache = next;
  try {
    persistPermissions(next);
  } catch {
    // Si el disco falla, la política queda aplicada en memoria para esta
    // sesión: es preferible a ignorar lo que el usuario acaba de decidir.
  }
  return { ...next };
}

/** Vuelve todo a los valores de fábrica. */
export function resetPermissions(): PermissionMap {
  const defaults = defaultPermissions();
  cache = defaults;
  try {
    persistPermissions(defaults);
  } catch {
    // Igual que arriba: se conserva en memoria.
  }
  return { ...defaults };
}

/** Limpia la caché (tests, o tras editar el archivo por fuera). */
export function resetPermissionsCache(): void {
  cache = null;
}
