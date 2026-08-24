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
  /** Guarda la conversación actual en el historial y abre una nueva. */
  saveAndStartNewSession: () => void;
  /** Descarta la conversación actual sin guardarla. */
  clearCurrentSession: () => void;
  /** Resume el contexto para liberar ventana sin perder el hilo. */
  compactConversation: () => void;
  /** Fija o retira la meta de la sesión. */
  toggleSessionGoal: () => void;
  /** Meta activa, para describirla en el comando. */
  goalSummary?: string;
  /** Prepara una sesión nueva con el contexto de un issue o PR. */
  openGitHubSession: () => void;
  /** Cuántos mensajes hay ahora, para saber si hay algo que compactar. */
  historyLength: number;
  /** Abre una pestaña concreta de los ajustes. */
  openConfigTab: (tabId: ConfigTab) => void;
  /** Navega a una ruta de la aplicación. */
  navigateTo: (route: string) => void;
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
      description: "Guardar esta conversación y empezar otra",
      type: "action",
      category: SLASH_CATEGORY.session,
      badge: "instantáneo",
      icon: "plus",
      action: context.saveAndStartNewSession,
    },
    {
      title: "/clear",
      // Distinto de /new a propósito: aquí NO se guarda. Es el equivalente a
      // vaciar la pizarra en vez de archivarla.
      description: "Borrar esta conversación sin guardarla",
      type: "action",
      category: SLASH_CATEGORY.session,
      badge: "instantáneo",
      icon: "trash",
      action: context.clearCurrentSession,
    },
    {
      title: "/goal",
      argsHint: "[meta]",
      description: context.goalSummary
        ? `Meta actual: ${context.goalSummary}`
        : "Fijar una meta: sigue trabajando hasta cumplirla",
      type: "action",
      category: SLASH_CATEGORY.session,
      icon: "flag",
      action: context.toggleSessionGoal,
    },
    {
      title: "/compact",
      description:
        context.historyLength > 1
          ? `Resumir el contexto (${context.historyLength} mensajes)`
          : "Nada que compactar todavía",
      type: "action",
      category: SLASH_CATEGORY.session,
      icon: "sparkles",
      action: context.compactConversation,
    },
    {
      title: "/github",
      argsHint: "[issue|PR]",
      description: "Preparar una sesión desde un issue o pull request",
      type: "action",
      category: SLASH_CATEGORY.session,
      icon: "git-branch",
      action: context.openGitHubSession,
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
      title: "/skills",
      description: "Habilidades reutilizables que Lumina puede ejecutar",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "academic",
      action: () => context.openConfigTab("skills"),
    },
    {
      title: "/mcp",
      description: "Servidores MCP y configuraciones cargadas",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "document",
      action: () => context.openConfigTab("configs"),
    },
    {
      title: "/indexing",
      description: "Estado del índice del código base",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "database",
      action: () => context.openConfigTab("indexing"),
    },
    {
      title: "/usage",
      description: "Tokens y coste por día",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "chart",
      action: () => context.navigateTo("/stats"),
    },
    {
      title: "/changes",
      description: "Recorrer los cambios archivo por archivo y por pasos",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "diff",
      action: () => context.navigateTo("/changes"),
    },
    {
      title: "/work",
      description: "Ver sesiones, metas, aprobaciones, tareas y consumo",
      type: "action",
      category: SLASH_CATEGORY.tools,
      icon: "chart",
      action: () => context.navigateTo("/work"),
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
