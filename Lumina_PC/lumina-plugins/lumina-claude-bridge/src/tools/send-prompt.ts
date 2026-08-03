/**
 * Tool: lumina_claude_app_send_prompt
 *
 * Bajo nivel — escribe directo en Claude App sin pasar por el router.
 * Útil para tests, o cuando el agente ya decidió manualmente.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ClaudeAppAdapter } from "../adapters/claude-app/adapter.js";

export function createSendPromptTool(adapter: ClaudeAppAdapter): AnyAgentTool {
  return {
    name: "lumina_claude_app_send_prompt",
    label: "Lumina Claude Bridge — Send Prompt (Claude App)",
    description:
      "Escribe un prompt directamente en la ventana de Claude App desktop y espera la respuesta. Salta el router. Útil cuando el caller ya decidió que va a chat-app.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    }),
    async execute(_toolCallId, params) {
      const input = params as { prompt: string };
      try {
        const result = await adapter.send(input.prompt, []);
        return jsonResult({ ok: true, response: result.response, meta: result.meta });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
