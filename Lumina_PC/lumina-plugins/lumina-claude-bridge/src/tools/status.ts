/**
 * Tool: lumina_claude_app_status
 *
 * Read-only — devuelve info de Claude App si está abierto (proceso, ventana,
 * monitor). Útil para que el agente diga "Claude App está en monitor 2,
 * arriba a la derecha" antes de escribir.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ClaudeAppAdapter } from "../adapters/claude-app/adapter.js";

export function createClaudeAppStatusTool(adapter: ClaudeAppAdapter): AnyAgentTool {
  return {
    name: "lumina_claude_app_status",
    label: "Lumina Claude Bridge — Claude App Status",
    description:
      "Devuelve si Claude App desktop está abierto, en qué monitor, y el rect de su ventana. Read-only. No escribe ni interactúa.",
    parameters: Type.Object({}),
    async execute() {
      const window = await adapter.locate();
      if (!window) {
        return jsonResult({ ok: false, running: false, message: "Claude App is not running" });
      }
      return jsonResult({
        ok: true,
        running: true,
        process: { name: window.processName, pid: window.processId },
        window: {
          title: window.title,
          handle: window.windowHandle,
          rect: window.rect,
          visible: window.isVisible,
          foreground: window.isForeground,
        },
        monitor: window.monitor,
      });
    },
  };
}
