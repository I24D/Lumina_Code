import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { bridgeGet, bridgePost } from "./bridgeClient.ts";
import { config } from "./config.ts";
import { delegateToLuminaCode } from "./luminaChatClient.ts";
import { memoryRecall, memorySave } from "./memoryClient.ts";

/**
 * Registers every Lumina capability as an MCP tool. Each tool is a thin, honest
 * forwarder onto an already-proven Lumina surface (the Lumina Code chat, the
 * Windows bridge, the unified-memory API) — the gateway adds reach and auth, not
 * new behavior.
 */

function jsonResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

export function registerLuminaTools(server: McpServer): void {
  // ── Write in the Lumina Code chat and get the agent's answer ───────────────
  server.registerTool(
    "lumina_code_chat",
    {
      title: "Escribir en el chat de Lumina Code",
      description:
        "Envía un mensaje/tarea al chat de Lumina Code (el agente completo con todas sus herramientas: código, terminal, MCP, control del PC) y devuelve su respuesta final. Úsalo para pedirle a Lumina Code que trabaje en el PC del usuario: editar/leer código, ejecutar acciones, responder WhatsApp con contexto, etc. Requiere que la barra lateral de Lumina Code esté abierta.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .describe("El mensaje o tarea para Lumina Code, en lenguaje natural."),
      },
    },
    async ({ message }) => {
      const result = await delegateToLuminaCode(message);
      if (!result.ok) {
        const hint =
          result.error === "chat_bridge_unavailable"
            ? "El puente al chat no está disponible. Abre la barra lateral de Lumina Code en el Dev Host e inténtalo de nuevo."
            : result.error === "timeout"
              ? "Lumina Code tardó demasiado o no hay una sesión de chat activa que atienda la tarea."
              : "Lumina Code no pudo completar la tarea.";
        return jsonResult(
          { ok: false, error: result.error, hint, answer: result.text },
          true,
        );
      }
      return jsonResult({ ok: true, answer: result.text });
    },
  );

  // ── Reply to a WhatsApp / Phone Link message ───────────────────────────────
  server.registerTool(
    "whatsapp_respond",
    {
      title: "Responder WhatsApp",
      description:
        "Responde un mensaje de WhatsApp / Enlace Móvil en el PC en un solo paso: pasa el nombre del contacto y el texto de respuesta. El nombre se empareja de forma difusa. Usa dryRun para simular sin enviar.",
      inputSchema: {
        contact: z
          .string()
          .min(1)
          .describe("Nombre del contacto/chat tal como aparece en WhatsApp."),
        message: z.string().min(1).max(1000).describe("Texto de la respuesta."),
        window: z
          .enum(["whatsapp", "phone_link"])
          .optional()
          .describe("Ventana objetivo. Por defecto WhatsApp de escritorio."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Si es true, prepara pero no envía."),
      },
    },
    async ({ contact, message, window, dryRun }) => {
      const result = await bridgePost("/whatsapp/reply", {
        contact,
        message,
        window,
        dryRun: dryRun === true,
      });
      return jsonResult(result.data, !result.ok);
    },
  );

  // ── Read what is on the PC (foreground app, system snapshot) ────────────────
  server.registerTool(
    "pc_system_context",
    {
      title: "Contexto del PC",
      description:
        "Devuelve una instantánea del estado del PC del usuario: aplicación en primer plano, ventanas, y contexto del sistema. Útil para saber qué está haciendo el usuario antes de actuar.",
      inputSchema: {},
    },
    async () => {
      const result = await bridgeGet("/system_context");
      return jsonResult(result.data, !result.ok);
    },
  );

  // ── Launch an application ──────────────────────────────────────────────────
  server.registerTool(
    "pc_open_application",
    {
      title: "Abrir aplicación",
      description:
        "Abre una aplicación, ajuste o URL en el PC (por nombre, alias o URL). Ej: 'WhatsApp', 'Enlace Móvil', 'notepad', 'https://...'.",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe("Nombre/alias de la app o URL a abrir."),
        waitForWindow: z
          .boolean()
          .optional()
          .describe("Esperar a que aparezca la ventana."),
      },
    },
    async ({ target, waitForWindow }) => {
      const result = await bridgePost("/open_application", {
        target,
        waitForWindow: waitForWindow === true,
      });
      return jsonResult(result.data, !result.ok);
    },
  );

  // ── Inspect the accessibility tree of a window (see, then act) ──────────────
  server.registerTool(
    "pc_ui_inspect",
    {
      title: "Inspeccionar UI (accesibilidad)",
      description:
        "Lee el árbol de accesibilidad de la ventana en primer plano (o la de un proceso). Con 'query' resuelve de forma difusa un objetivo en lenguaje natural a elementos candidatos con su AutomationId/Name; sin 'query' devuelve los elementos interactuables. Léelo antes de usar pc_ui_interact.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Objetivo en lenguaje natural, ej: 'botón Enviar'."),
        processName: z
          .string()
          .optional()
          .describe("Limitar a un proceso, ej: 'WhatsApp.exe'."),
        maxDepth: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, processName, maxDepth }) => {
      const result = await bridgePost("/ui_inspect", {
        query,
        processName,
        maxDepth,
      });
      return jsonResult(result.data, !result.ok);
    },
  );

  // ── Act on a UI element by identity (never by guessed coordinates) ─────────
  server.registerTool(
    "pc_ui_interact",
    {
      title: "Actuar sobre un elemento de UI",
      description:
        "Actúa sobre un elemento por su identidad (AutomationId o Name, obtenidos con pc_ui_inspect) mediante patrones nativos de UIA: invoke/click, set_value (escribir), toggle, select, focus. Funciona aunque la ventana no esté en primer plano y nunca adivina coordenadas.",
      inputSchema: {
        automationId: z
          .string()
          .optional()
          .describe("AutomationId del elemento (preferido)."),
        name: z
          .string()
          .optional()
          .describe("Name del elemento (si no hay AutomationId)."),
        action: z
          .enum(["invoke", "click", "set_value", "toggle", "select", "focus"])
          .optional()
          .describe("Acción a ejecutar. Por defecto invoke."),
        value: z
          .string()
          .optional()
          .describe("Texto a escribir cuando action = set_value."),
        thenPress: z
          .enum(["enter", "tab", "escape"])
          .optional()
          .describe("Tecla a presionar después de la acción."),
      },
    },
    async ({ automationId, name, action, value, thenPress }) => {
      if (!automationId && !name) {
        return jsonResult(
          { ok: false, error: "ui_interact_requires_automationId_or_name" },
          true,
        );
      }
      const result = await bridgePost("/ui_interact", {
        automationId,
        name,
        action,
        value,
        thenPress,
      });
      return jsonResult(result.data, !result.ok);
    },
  );

  // ── Recall from the shared long-term memory ────────────────────────────────
  server.registerTool(
    "memory_recall",
    {
      title: "Recordar (memoria unificada)",
      description:
        "Búsqueda semántica en la memoria de largo plazo compartida (la misma que usan Start Talk y Lumina Code). Devuelve hechos, identidad y conocimiento relevantes para la consulta.",
      inputSchema: {
        query: z.string().min(1).describe("Qué recordar."),
        userId: z
          .string()
          .optional()
          .describe("Identidad. Por defecto el dueño del PC."),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, userId, limit }) => {
      const result = await memoryRecall(
        userId?.trim() || config.defaultUserId,
        query,
        limit ?? 8,
      );
      return jsonResult(result.data, !result.ok);
    },
  );

  // ── Store a durable fact in shared memory ──────────────────────────────────
  server.registerTool(
    "memory_save",
    {
      title: "Guardar en memoria",
      description:
        "Guarda un hecho duradero sobre el usuario en la memoria compartida, para que Lumina Code y Start Talk lo recuerden después. Úsalo solo para hechos estables y útiles, no para cosas triviales del momento.",
      inputSchema: {
        memory: z.string().min(1).describe("El hecho a recordar, en una frase."),
        userId: z
          .string()
          .optional()
          .describe("Identidad. Por defecto el dueño del PC."),
      },
    },
    async ({ memory, userId }) => {
      const result = await memorySave(
        userId?.trim() || config.defaultUserId,
        memory,
      );
      return jsonResult(result.data, !result.ok);
    },
  );
}
