/**
 * action-tools.ts — Tool: lumina_action_plan
 *
 * Accepts a structured ActionPlan, validates it, registers it in the
 * planner store and returns the canonical plan id. The agent then walks
 * the steps one-by-one (each one is a regular tool call) so existing
 * approval/audit semantics are preserved.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { validatePlan, type ActionPlan } from "./planner.js";

export type PlanStore = {
  register(plan: ActionPlan): void;
  list(): ReadonlyArray<ActionPlan>;
  get(id: string): ActionPlan | null;
};

export function createPlanStore(): PlanStore {
  const plans: ActionPlan[] = [];
  return {
    register(plan) {
      plans.unshift(plan);
      if (plans.length > 64) plans.length = 64;
    },
    list() {
      return plans.slice();
    },
    get(id) {
      return plans.find((p) => p.id === id) ?? null;
    },
  };
}

export function createActionPlanTool(store: PlanStore): AnyAgentTool {
  return {
    name: "lumina_action_plan",
    label: "Lumina Action Plan",
    description:
      "Registers a structured plan composed of subsequent tool calls. Use this when a voice request needs " +
      "more than one step: 'abre Chrome, busca X, copia el primer resultado, mándamelo por WhatsApp'. " +
      "Each step has a toolName, params, description and pre-classified risk. After registering, walk the " +
      "steps yourself — calling each tool in order, stopping if stopOnError and a step fails.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 3, maxLength: 480 }),
      stopOnError: Type.Optional(Type.Boolean({ default: true })),
      steps: Type.Array(
        Type.Object({
          toolName: Type.String({ minLength: 1, maxLength: 80 }),
          description: Type.String({ minLength: 1, maxLength: 240 }),
          params: Type.Optional(Type.Unknown()),
          risk: Type.Optional(
            Type.Union([
              Type.Literal("SAFE"),
              Type.Literal("WARNING"),
              Type.Literal("HIGH_RISK"),
              Type.Literal("CRITICAL"),
            ]),
          ),
        }),
        { minItems: 1, maxItems: 32 },
      ),
    }),
    async execute(_id, params) {
      const v = validatePlan(params);
      if (!v.ok) throw new ToolInputError(v.error);
      store.register(v.plan);
      return jsonResult({ ok: true, plan: v.plan });
    },
  };
}
