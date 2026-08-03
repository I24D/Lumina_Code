/**
 * skill-eval-tool.ts — Tools: lumina_skill_eval + lumina_skill_eval_record
 *
 * `lumina_skill_eval` reports historical success rate / latency for a
 * learned skill. `lumina_skill_eval_record` is called by replay-engine
 * indirectly (via ActionLog tap) when a learned skill's replay run
 * completes; agents normally don't call it directly.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { SkillEvalStore } from "./skill-eval.js";

export function createSkillEvalTool(store: SkillEvalStore): AnyAgentTool {
  return {
    name: "lumina_skill_eval",
    label: "Lumina Skill — Eval Stats",
    description:
      "Returns historical success rate, average latency, and recent runs for a learned skill. " +
      "Useful before suggesting a replay: 'this skill has 80% success rate over 10 runs' vs " +
      "'never used before' lets the user calibrate trust.",
    parameters: Type.Object({
      skillId: Type.String({ minLength: 1, maxLength: 80 }),
      lastN: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 20 })),
    }),
    async execute(_id, p) {
      const id = p.skillId?.trim();
      if (!id) throw new ToolInputError("skillId is required");
      const stats = store.stats(id, p.lastN ?? 20);
      return jsonResult({ ok: true, stats });
    },
  };
}

export function createSkillEvalRecordTool(store: SkillEvalStore): AnyAgentTool {
  return {
    name: "lumina_skill_eval_record",
    label: "Lumina Skill — Record Eval",
    description:
      "Append one eval entry for a learned skill. Normally the replay engine wires this " +
      "automatically; agents call it directly only to fix up missing entries.",
    parameters: Type.Object({
      skillId: Type.String({ minLength: 1, maxLength: 80 }),
      runId: Type.String({ minLength: 1, maxLength: 80 }),
      status: Type.Union([Type.Literal("done"), Type.Literal("aborted"), Type.Literal("error")]),
      stepCount: Type.Number({ minimum: 0 }),
      dispatched: Type.Number({ minimum: 0 }),
      failed: Type.Number({ minimum: 0 }),
      verifyFailed: Type.Number({ minimum: 0 }),
      avgLatencyMs: Type.Number({ minimum: 0 }),
      strategy: Type.String({ minLength: 1, maxLength: 32 }),
      mode: Type.String({ minLength: 1, maxLength: 32 }),
    }),
    async execute(_id, p) {
      store.recordRun(p.skillId.trim(), {
        atISO: new Date().toISOString(),
        runId: p.runId,
        status: p.status as "done" | "aborted" | "error",
        stepCount: p.stepCount,
        dispatched: p.dispatched,
        failed: p.failed,
        verifyFailed: p.verifyFailed,
        avgLatencyMs: p.avgLatencyMs,
        strategy: p.strategy,
        mode: p.mode,
      });
      return jsonResult({ ok: true });
    },
  };
}
