/**
 * director-tool.ts — Tool: lumina_director_route
 *
 * Voice-first router. The main agent calls this at the start of every
 * non-trivial turn:
 *   1. Pass the user's utterance as `intent`.
 *   2. Receive top-1 agent + a list of allowed tools.
 *   3. Adopt the agent's persona, restrict tool calls to its toolset,
 *      and proceed.
 *
 * If `ambiguous` is true, the agent asks the user out loud which of the
 * top candidates they meant.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { SPECIALISED_AGENTS } from "./catalog.js";
import { routeIntent } from "./director.js";

export function createDirectorRouteTool(): AnyAgentTool {
  return {
    name: "lumina_director_route",
    label: "Lumina Director",
    description:
      "Routes a user intent to the most suitable specialised agent (Atlas/Mira/Postino/Horus/Nimbus/" +
      "Vidrio/Soren/Bit/Vault/Iris/Vox/Forge). Returns the top candidate with its mission, persona, tool " +
      "allowlist and confidence. Call this on EVERY voice turn before deciding which tools to use.",
    parameters: Type.Object({
      intent: Type.String({ minLength: 1, maxLength: 2000 }),
      topK: Type.Optional(Type.Number({ minimum: 1, maximum: 6, default: 3 })),
    }),
    async execute(_id, params) {
      const intent = params.intent?.trim();
      if (!intent) throw new ToolInputError("intent is required");
      const result = routeIntent(intent, params.topK ?? 3);
      return jsonResult({
        ok: true,
        intent: result.intent,
        ambiguous: result.ambiguous,
        top:
          result.top === null
            ? null
            : {
                id: result.top.agent.id,
                displayName: result.top.agent.displayName,
                mission: result.top.agent.mission,
                tools: result.top.agent.tools,
                personality: result.top.agent.personality,
                score: result.top.score,
                hits: result.top.hits,
              },
        candidates: result.candidates.map((c) => ({
          id: c.agent.id,
          displayName: c.agent.displayName,
          mission: c.agent.mission,
          score: c.score,
          hits: c.hits,
        })),
        roster: SPECIALISED_AGENTS.map((a) => ({
          id: a.id,
          displayName: a.displayName,
          mission: a.mission,
        })),
      });
    },
  };
}
