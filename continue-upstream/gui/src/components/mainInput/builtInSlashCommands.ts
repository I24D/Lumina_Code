/**
 * builtInSlashCommands.ts — Comandos `/` que EJECUTAN algo.
 *
 * Hasta ahora el desplegable de `/` solo ofrecía prompts: plantillas de texto
 * que se insertan en el editor. Estos son distintos — son acciones del cliente
 * que ocurren en el acto (cambiar de modelo, limpiar la sesión, abrir
 * Privacidad) y nunca llegan al modelo como mensaje.
 *
 * Se distinguen por `type: "action"`, que el desplegable ya sabía tratar: al
 * elegirlos se llama a `action()` en vez de insertar un bloque de prompt.
 *
 * Categorías e insignias existen para que la lista siga siendo legible cuando
 * crezca: agrupadas por SESIÓN / MODELO / HERRAMIENTAS, con los argumentos que
 * aceptan y una pista de qué pasa al pulsarlos.
 */
import type { ConfigTab } from "../../util/navigation";
import type { ComboBoxItem } from "./types";

/** Contexto que necesitan las acciones para hacer su trabajo. */
export interface SlashCommandContext {
  /** Vacía el historial y empieza de cero. */
  newSession: () => void;
  /** Abre una pestaña concreta de los ajustes. */
  openConfigTab: (tabId: ConfigTab) => void;
  /** Cambia el modo de la sesión (chat / agent / plan). */
  setMode: (mode: "chat" | "agent" | "plan") => void;
  /** Modo actual, para mostrarlo en la descripción. */
  currentMode: string;
  /** Detiene la generación en curso. */
  stopStreaming: () => void;
  /** True si hay algo generándose ahora mismo. */
  isStreaming: boolean;
  /** Nombre del modelo seleccionado, para mostrarlo. */
  currentModel?: string;
}

export const SLASH_CATEGORY = {
  session: "SESIÓN",
  model: "MODELO",
  tools: "HERRAMIENTAS",
} as const;

/**
 * Construye los comandos integrados. Es una función y no una constante porque
 * varias descripciones muestran el estado actual (modelo activo, modo), que
 * cambia entre renders.
 */
export function buildBuiltInSlashCommands(
  context: SlashCommandContext,
): ComboBoxItem[] {
  return [
    // ---- SESIÓN ----
    {
      title: "/new",
      description: "Empezar una sesión nueva",
      type: "action",
      category: SLASH_CATEGORY.session,
      badge: "instantáneo",
      icon: "plus",
      action: context.newSession,
    },
    {
      title: "/stop",
      description: context.isStreaming
        ? "Detener la generación en curso"
        : "Nada que detener ahora mismo",
      type: "action",
      category: SLASH_CATEGORY.session,
      badge: "instantáneo",
      icon: "stop",
      action: context.stopStreaming,
    },
    // ---- MODELO ----
    {
      title: "/mode",
      argsHint: "[chat|agent|plan]",
      description: `Cambiar el modo. Ahora: ${context.currentMode}`,
      type: "action",
      category: SLASH_CATEGORY.model,
      badge: "3 opciones",
      icon: "sparkles",
      action: () => {
        // Rota entre los tres modos: sin submenú, un solo gesto.
        const order = ["chat", "agent", "plan"] as const;
        const next =
          order[(order.indexOf(context.currentMode as any) + 1) % order.length];
        context.setMode(next);
      },
    },
    {
      title: "/model",
      description: context.currentModel
        ? `Elegir modelo. Ahora: ${context.currentModel}`
        : "Elegir el modelo del chat",
      type: "action",
      category: SLASH_CATEGORY.model,
      icon: "cube",
      action: () => context.openConfigTab("models"),
    },
    // ---- HERRAMIENTAS ----
    {
      title: "/tools",
      description: "Ver y ajustar las herramientas disponibles",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "wrench",
      action: () => context.openConfigTab("tools"),
    },
    {
      title: "/privacy",
      description: "Permisos de micrófono, cámara, pantalla y acciones",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "shield",
      action: () => context.openConfigTab("privacy"),
    },
    {
      title: "/rules",
      description: "Reglas que Lumina sigue en este proyecto",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "pencil",
      action: () => context.openConfigTab("rules"),
    },
    {
      title: "/settings",
      description: "Ajustes generales de Lumina Code",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "cog",
      action: () => context.openConfigTab("settings"),
    },
    {
      title: "/help",
      description: "Atajos de teclado, documentación y diagnóstico",
      type: "action",
      category: SLASH_CATEGORY.tools,
      badge: "instantáneo",
      icon: "question",
      action: () => context.openConfigTab("help"),
    },
  ];
}

/**
 * Ordena los elementos por categoría manteniendo el orden interno de cada
 * grupo, y deja al final lo que no tiene categoría (los prompts de siempre).
 * Devuelve la lista lista para pintar, con `category` intacto para que el
 * desplegable pueda insertar los encabezados.
 */
export function groupSlashCommands(items: ComboBoxItem[]): ComboBoxItem[] {
  const order = [
    SLASH_CATEGORY.session,
    SLASH_CATEGORY.model,
    SLASH_CATEGORY.tools,
  ];
  const rank = (item: ComboBoxItem) => {
    if (!item.category) {
      return order.length;
    }
    const index = order.indexOf(item.category as (typeof order)[number]);
    return index === -1 ? order.length : index;
  };
  // Estable: sort de JS lo es desde ES2019, así que el orden dentro de cada
  // categoría es el de definición.
  return [...items].sort((a, b) => rank(a) - rank(b));
}
