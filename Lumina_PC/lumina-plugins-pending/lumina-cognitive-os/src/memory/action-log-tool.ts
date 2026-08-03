/**
 * action-log-tool.ts — Agent tools for the semantic action log.
 *
 *   lumina_working_memory_recall  — read recent actions by window + filter
 *   lumina_working_memory_log     — manually append an entry (rare; the
 *                                   workflow engine auto-logs every step)
 *
 * Voice flow: "Lumina, ¿qué hicimos hace un rato?"
 *   → recall({ windowSeconds: 300 })
 *   → "Hace 4 minutos abriste Chrome, luego enfoqué VS Code…"
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { ActionLogStore } from "./action-log.js";

const RESULTS = ["ok", "skipped", "error", "warn"] as const;

export function createWorkingMemoryRecallTool(store: ActionLogStore): AnyAgentTool {
  return {
    name: "lumina_working_memory_recall",
    label: "Lumina Working Memory — Recall",
    description:
      "Returns the most recent semantic actions (workflow steps, UI clicks, app launches, voice intents) " +
      "from the action log, filtered by time window and/or action substring. Use this when the user asks " +
      "'¿qué hicimos hace X?', '¿qué pasó con Y?', or to ground a follow-up like 'sigue donde quedamos'.",
    parameters: Type.Object({
      windowSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 86400,
          description: "Time window in seconds (e.g. 300 = last 5 minutes). Default: 600.",
        }),
      ),
      action: Type.Optional(
        Type.String({
          maxLength: 80,
          description: "Substring filter on action verb (e.g. 'ui.click', 'launch', 'workflow').",
        }),
      ),
      source: Type.Optional(
        Type.String({
          maxLength: 40,
          description: "Exact source filter ('workflow-engine', 'agent', 'bridge', 'wake').",
        }),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 })),
    }),
    async execute(_id, params) {
      const entries = store.recall({
        windowSeconds: params.windowSeconds ?? 600,
        action: params.action,
        source: params.source,
        limit: params.limit,
      });
      return jsonResult({
        ok: true,
        count: entries.length,
        windowSeconds: params.windowSeconds ?? 600,
        entries,
      });
    },
  };
}

export function createWorkingMemoryLogTool(store: ActionLogStore): AnyAgentTool {
  return {
    name: "lumina_working_memory_log",
    label: "Lumina Working Memory — Manual Log",
    description:
      "Manually append an entry to the action log. PREFER letting the workflow engine auto-log each step. " +
      "Use this only for actions the engine can't see (a manual decision, a user observation worth remembering).",
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 80 }),
      target: Type.String({ minLength: 1, maxLength: 200 }),
      result: Type.Union(RESULTS.map((r) => Type.Literal(r))),
      detail: Type.Optional(Type.String({ maxLength: 480 })),
      source: Type.Optional(Type.String({ maxLength: 40 })),
    }),
    async execute(_id, params) {
      const action = params.action?.trim();
      const target = params.target?.trim();
      if (!action) throw new ToolInputError("action is required");
      if (!target) throw new ToolInputError("target is required");
      const entry = store.append({
        action,
        target,
        result: params.result,
        detail: params.detail,
        source: params.source ?? "agent",
      });
      return jsonResult({ ok: true, entry });
    },
  };
}
