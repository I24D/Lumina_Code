/**
 * risk-tool.ts — Tool: lumina_risk_evaluate
 *
 * The agent calls this BEFORE performing any non-trivial action so the
 * user always sees the risk tier of what is about to happen. Voice flow:
 *   1. Lumina hears "Lumina, borra la carpeta X".
 *   2. Lumina calls lumina_risk_evaluate({ category:"write", action:"delete", target:"X" }).
 *   3. If tier is HIGH_RISK / CRITICAL, Lumina asks for confirmation out loud.
 *   4. Only then does it execute via the underlying tool.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { RISK_CATEGORIES, type RiskCategory } from "./policies.js";
import type { RiskEngine } from "./risk-engine.js";

export function createRiskEvaluateTool(engine: RiskEngine): AnyAgentTool {
  return {
    name: "lumina_risk_evaluate",
    label: "Lumina Risk Evaluate",
    description:
      "Classifies a pending action into one of four tiers: SAFE, WARNING, HIGH_RISK, CRITICAL. " +
      "Call this BEFORE executing any action with side-effects so the user is asked for confirmation " +
      "when needed. The decision is auditable via lumina_risk_recent.",
    parameters: Type.Object({
      category: Type.Union(
        RISK_CATEGORIES.map((c) => Type.Literal(c)),
        { description: "Action category." },
      ),
      action: Type.String({
        description:
          "Short verb-phrase describing the action, e.g. 'shutdown computer', 'send email', " +
          "'rm -rf node_modules'.",
        minLength: 1,
        maxLength: 512,
      }),
      target: Type.Optional(
        Type.String({
          description:
            "Optional path, URL or recipient the action operates on.",
          maxLength: 1024,
        }),
      ),
    }),
    async execute(_id, params) {
      const category = params.category as RiskCategory;
      const action = params.action?.trim();
      if (!action) throw new ToolInputError("action is required");
      const decision = engine.evaluate({
        category,
        action,
        target: params.target,
      });
      return jsonResult({
        ok: true,
        tier: decision.tier,
        reason: decision.reason,
        ruleId: decision.ruleId,
        requiresConfirmation: decision.requiresConfirmation,
        requiresDoubleConfirmation: decision.requiresDoubleConfirmation,
        mustAudit: decision.mustAudit,
        atISO: decision.atISO,
      });
    },
  };
}

export function createRiskRecentTool(engine: RiskEngine): AnyAgentTool {
  return {
    name: "lumina_risk_recent",
    label: "Lumina Risk Recent",
    description:
      "Returns the last N risk-engine decisions for transparency. Use this when the user asks " +
      "'qué decidió Lumina recientemente' or to surface CRITICAL/HIGH_RISK events on the panel.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 256, default: 16 }),
      ),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 16;
      return jsonResult({
        ok: true,
        decisions: engine.recent(limit),
        stats: engine.getStats(),
      });
    },
  };
}
