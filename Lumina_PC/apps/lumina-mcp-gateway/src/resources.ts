import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { bridgeGet } from "./bridgeClient.ts";
import { config } from "./config.ts";
import { memoryProactive } from "./memoryClient.ts";

/**
 * Read-only resources Claude can pull for context without taking an action:
 * what is on the PC right now, whether the bridge is healthy, and a proactive
 * memory brief (open threads) for the owner.
 */

function jsonContents(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerLuminaResources(server: McpServer): void {
  server.registerResource(
    "pc-status",
    "lumina://pc/status",
    {
      title: "Estado del PC",
      description: "Instantánea del contexto del sistema del usuario.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await bridgeGet("/system_context");
      return jsonContents(uri, result.data);
    },
  );

  server.registerResource(
    "bridge-health",
    "lumina://bridge/health",
    {
      title: "Salud del Windows Bridge",
      description: "Estado del puente de acciones nativas del PC (:8765).",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await bridgeGet("/health");
      return jsonContents(uri, { ok: result.ok, ...(result.data as object) });
    },
  );

  server.registerResource(
    "memory-brief",
    "lumina://memory/brief",
    {
      title: "Brief de memoria (hilos abiertos)",
      description:
        "Resumen proactivo de la memoria del dueño: temas y compromisos abiertos.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await memoryProactive(config.defaultUserId);
      return jsonContents(uri, result.data);
    },
  );
}
