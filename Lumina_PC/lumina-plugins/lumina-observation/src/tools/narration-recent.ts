/**
 * Tool: lumina_narration_recent — returns the most recent narrations.
 *
 * Phase 3 holds narrations in memory only; Phase 4 will pipe them to the
 * Initiative Daemon and (gated) into Talk's voice channel. Until then this
 * tool lets the agent inspect what the narrator has been saying for
 * debugging and for replying when the user asks "¿qué has notado?".
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ObservationService } from "../services/observation-service.js";

export function createNarrationRecentTool(service: ObservationService): AnyAgentTool {
  return {
    name: "lumina_narration_recent",
    label: "Lumina Recent Narration",
    description:
      "Returns the most recent narrations produced by Lumina's observer (newest first). Each narration is one short Spanish sentence describing a change Lumina noticed (window switch, user returned, RAM spike, etc.). The narrator is rate-limited; an empty array is normal during quiet periods.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          description: "How many recent narrations to return. Default 8, max 32.",
          minimum: 1,
          maximum: 32,
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const input = params as { limit?: number };
      const limit = input.limit ?? 8;
      const list = service.recentNarrations(limit);
      return jsonResult({
        ok: true,
        count: list.length,
        narrations: list,
      });
    },
  };
}
