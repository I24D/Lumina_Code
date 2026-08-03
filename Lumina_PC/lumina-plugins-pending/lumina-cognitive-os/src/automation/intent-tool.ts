/**
 * intent-tool.ts — Tool: lumina_intent_run
 *
 * The agent passes a free-form utterance. If it matches a template, the
 * recipe is returned and the agent walks it. If not, the tool returns
 * `matched=false` and the agent falls back to the Director.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { INTENT_TEMPLATES, matchTemplate } from "./templates.js";

export function createIntentRunTool(): AnyAgentTool {
  return {
    name: "lumina_intent_run",
    label: "Lumina Intent Router",
    description:
      "Matches a user utterance against pre-built intent templates ('organiza mi día', 'revisa correos', " +
      "'reporte de ventas', 'agenda reunión', ...). Returns matched=true + recipe of tool calls when " +
      "there's a fit, matched=false otherwise. Call this FIRST when the user gives a multi-step command.",
    parameters: Type.Object({
      utterance: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_id, params) {
      const utt = params.utterance?.trim();
      if (!utt) throw new ToolInputError("utterance is required");
      const tpl = matchTemplate(utt);
      if (!tpl) {
        return jsonResult({
          ok: true,
          matched: false,
          availableTemplates: INTENT_TEMPLATES.map((t) => ({
            id: t.id,
            displayName: t.displayName,
            triggers: t.triggers,
          })),
        });
      }
      return jsonResult({
        ok: true,
        matched: true,
        template: {
          id: tpl.id,
          displayName: tpl.displayName,
          description: tpl.description,
          recipe: tpl.recipe,
        },
      });
    },
  };
}
