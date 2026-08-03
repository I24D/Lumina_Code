/**
 * Tool: lumina_claude_dispatch
 *
 * Punto de entrada principal. El agente (texto o voz) llama esto con un
 * transcript y opcionalmente un hint/forceTarget. El bridge clasifica,
 * ejecuta, devuelve respuesta + metadata.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ClaudeBridge } from "../bridge.js";

export function createDispatchTool(bridge: ClaudeBridge): AnyAgentTool {
  return {
    name: "lumina_claude_dispatch",
    label: "Lumina Claude Bridge — Dispatch",
    description:
      "Delega una tarea a uno de los tres destinos Claude: chat-app (Claude App desktop via UI automation), code-cli (claude CLI spawn), o cowork (stub). El router clasifica automáticamente según keywords, o el caller puede forzar via forceTarget/hint. Devuelve la respuesta textual + metadata del adapter.",
    parameters: Type.Object({
      transcript: Type.String({
        description: "Texto transcrito de la voz del usuario o input directo. Lo que se debe enviar a Claude.",
        minLength: 1,
        maxLength: 100_000,
      }),
      hint: Type.Optional(
        Type.Union([Type.Literal("chat"), Type.Literal("code"), Type.Literal("cowork")], {
          description: "Pista del tipo de tarea. Acelera la clasificación.",
        }),
      ),
      forceTarget: Type.Optional(
        Type.Union(
          [Type.Literal("chat-app"), Type.Literal("code-cli"), Type.Literal("cowork")],
          { description: "Forzar el destino (skip router)." },
        ),
      ),
      attachments: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
          maxItems: 16,
          description: "Rutas absolutas de archivos a adjuntar. Solo code-cli las soporta hoy.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const input = params as {
        transcript: string;
        hint?: "chat" | "code" | "cowork";
        forceTarget?: "chat-app" | "code-cli" | "cowork";
        attachments?: string[];
      };
      const result = await bridge.dispatch({
        transcript: input.transcript,
        hint: input.hint,
        forceTarget: input.forceTarget,
        attachments: input.attachments,
      });
      return jsonResult(result as Record<string, unknown>);
    },
  };
}
