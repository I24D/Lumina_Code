/**
 * replay-tool.ts — Agent tools for the LfD Replayer.
 *
 *   lumina_replay_run     execute a recording with a chosen strategy
 *   lumina_replay_status  inspect a run (steps so far, latency, errors)
 *   lumina_replay_list    enumerate runs
 *   lumina_replay_abort   request cancellation
 *   lumina_replay_dry     fast SHORTCUT: simulate (mode='simulate') with
 *                         a one-call response so the agent can preview
 *                         what the replay WOULD do without dispatching
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { ReplayEngine } from "./replay-engine.js";
import { ALL_STRATEGY_IDS, type ReplayMode, type StrategyId } from "./strategies/types.js";
import { STRATEGIES } from "./strategies/registry.js";

const STRATEGY_LITERALS = ALL_STRATEGY_IDS.map((id) => Type.Literal(id));
const MODE_LITERALS = [Type.Literal("simulate"), Type.Literal("production")] as const;

export function createReplayRunTool(engine: ReplayEngine): AnyAgentTool {
  return {
    name: "lumina_replay_run",
    label: "Lumina Replay — Run",
    description:
      "Replays a recorded session using a chosen strategy. mode='simulate' logs what WOULD be dispatched " +
      "without touching the Bridge — safe to call anywhere. mode='production' actually clicks and types — " +
      "the calling agent MUST confirm with the user first. Default strategy is 'hybrid' (UIA → vision → " +
      "naive fallback chain). Returns the full run record including per-step verification results.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 80 }),
      strategy: Type.Optional(Type.Union(STRATEGY_LITERALS, { default: "hybrid" })),
      mode: Type.Optional(Type.Union(MODE_LITERALS, { default: "simulate" })),
      verifyEachStep: Type.Optional(Type.Boolean({ description: "Default: true when mode=production." })),
      interStepDelayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000, default: 250 })),
      maxSteps: Type.Optional(Type.Number({ minimum: 1, maximum: 5_000, default: 5_000 })),
      confirm: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Required true when mode='production' to protect against accidental dispatch.",
        }),
      ),
    }),
    async execute(_id, p) {
      const sessionId = p.sessionId?.trim();
      if (!sessionId) throw new ToolInputError("sessionId is required");
      const mode = (p.mode as ReplayMode) ?? "simulate";
      if (mode === "production" && !p.confirm) {
        return jsonResult({
          ok: false,
          refused: "needs-confirmation",
          hint: "Production replay actually clicks/types. Show the user the recording summary and " +
                "re-call with confirm: true after they explicitly approve.",
        });
      }
      const run = await engine.run({
        sessionId,
        strategyId: (p.strategy as StrategyId) ?? "hybrid",
        mode,
        verifyEachStep: p.verifyEachStep,
        interStepDelayMs: p.interStepDelayMs,
        maxSteps: p.maxSteps,
      });
      return jsonResult({
        ok: run.status === "done",
        runId: run.id,
        status: run.status,
        stepCount: run.steps.length,
        firstError: run.steps.find((s) => s.error)?.error,
        summary: summarizeRun(run),
        steps: run.steps.slice(-Math.min(50, run.steps.length)),
      });
    },
  };
}

export function createReplayStatusTool(engine: ReplayEngine): AnyAgentTool {
  return {
    name: "lumina_replay_status",
    label: "Lumina Replay — Status",
    description: "Returns a run's status, summary stats, and the last 50 steps.",
    parameters: Type.Object({
      runId: Type.String({ minLength: 1, maxLength: 80 }),
    }),
    async execute(_id, p) {
      const r = engine.get(p.runId.trim());
      if (!r) return jsonResult({ ok: false, error: `run '${p.runId}' not found` });
      return jsonResult({
        ok: true,
        runId: r.id,
        status: r.status,
        sessionId: r.sessionId,
        strategy: r.strategyId,
        mode: r.mode,
        stepCount: r.steps.length,
        summary: summarizeRun(r),
        steps: r.steps.slice(-50),
      });
    },
  };
}

export function createReplayListTool(engine: ReplayEngine): AnyAgentTool {
  return {
    name: "lumina_replay_list",
    label: "Lumina Replay — List",
    description: "Enumerates known replay runs in this session.",
    parameters: Type.Object({}),
    async execute() {
      const runs = engine.list().map((r) => ({
        runId: r.id,
        sessionId: r.sessionId,
        strategy: r.strategyId,
        mode: r.mode,
        status: r.status,
        stepCount: r.steps.length,
        createdAtISO: r.createdAtISO,
        finishedAtISO: r.finishedAtISO ?? null,
      }));
      return jsonResult({ ok: true, count: runs.length, runs });
    },
  };
}

export function createReplayAbortTool(engine: ReplayEngine): AnyAgentTool {
  return {
    name: "lumina_replay_abort",
    label: "Lumina Replay — Abort",
    description: "Request cancellation of a running replay. The next step boundary will honor it.",
    parameters: Type.Object({
      runId: Type.String({ minLength: 1, maxLength: 80 }),
    }),
    async execute(_id, p) {
      const ok = engine.abort(p.runId.trim());
      return jsonResult({ ok, runId: p.runId });
    },
  };
}

export function createReplayStrategiesTool(): AnyAgentTool {
  return {
    name: "lumina_replay_strategies",
    label: "Lumina Replay — Strategies",
    description: "Lists the registered replay strategies and their one-line descriptions.",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({
        ok: true,
        strategies: Object.entries(STRATEGIES).map(([id, s]) => ({
          id,
          description: s.description,
        })),
      });
    },
  };
}

type RunForSummary = ReturnType<ReplayEngine["get"]>;
function summarizeRun(run: NonNullable<RunForSummary>): Record<string, unknown> {
  let dispatched = 0;
  let skipped = 0;
  let failed = 0;
  let verifyFailed = 0;
  let totalLatency = 0;
  for (const s of run.steps) {
    if (s.error) failed++;
    if (s.resolved.kind === "skip") skipped++;
    else if (s.dispatched) dispatched++;
    if (s.verification && !s.verification.ok) verifyFailed++;
    totalLatency += s.latencyMs;
  }
  return {
    dispatched,
    skipped,
    failed,
    verifyFailed,
    avgLatencyMs: run.steps.length ? Math.round(totalLatency / run.steps.length) : 0,
  };
}
