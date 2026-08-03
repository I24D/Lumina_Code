/**
 * loop-tools.ts — PC Operator agent tools.
 *
 *   lumina_pc_do          — start + run + return the full trace
 *   lumina_pc_do_status   — inspect a prior run
 *   lumina_pc_do_list     — list all runs in this gateway session
 *   lumina_pc_do_abort    — cooperative cancellation of a running run
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { BrainProviderName } from "./brain-gemini.js";
import type { CostMeter } from "./cost-meter.js";
import type { PcOperatorEngine } from "./loop-engine.js";
import type { SkillHealthTracker } from "./skill-health-tracker.js";

function summarizeRun(run: ReturnType<PcOperatorEngine["get"]>): Record<string, unknown> {
  if (!run) return { ok: false, error: "run_not_found" };
  return {
    ok: true,
    id: run.id,
    goal: run.goal,
    mode: run.mode,
    requestedBrainProvider: run.requestedBrainProvider,
    requestedBrainModel: run.requestedBrainModel,
    status: run.status,
    startedAtISO: run.startedAtISO,
    finishedAtISO: run.finishedAtISO,
    stepCount: run.steps.length,
    finalSummary: run.finalSummary,
    stuckReason: run.stuckReason,
    errorMessage: run.errorMessage,
    steps: run.steps.map((s) => ({
      iteration: s.iteration,
      atISO: s.atISO,
      action: s.action,
      dispatch: s.dispatch
        ? {
            ok: s.dispatch.ok,
            dispatched: s.dispatch.dispatched,
            verifiedByTool: s.dispatch.verifiedByTool,
            toolName: s.dispatch.toolName,
            error: s.dispatch.errorMessage,
          }
        : null,
      thinkMs: s.thinkMs,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      brainProvider: s.brainProvider,
      brainModel: s.brainModel,
      foreground: s.observation.foregroundProcess,
    })),
  };
}

export function createPcDoTool(engine: PcOperatorEngine): AnyAgentTool {
  return {
    name: "lumina_pc_do",
    label: "Lumina PC — Do (autonomous loop)",
    description:
      "AUTONOMOUS PC OPERATOR. Recibe una meta en lenguaje natural ('abre YouTube y reproduce Despacito', " +
      "'busca el archivo X en el Explorador', 'arrastra esta card a Done') y ejecuta internamente un loop " +
      "observe → think (multi-provider: Gemini/OpenAI/Anthropic/Ollama) → act (smart tools) → verify → repeat hasta done/stuck/maxIterations. " +
      "El agente solo hace UNA llamada. Devuelve toda la trace: cada paso con su acción decidida, su resultado, " +
      "y el final summary. Modo `simulate` para preview sin dispatchar. Codex, Claude Code, Ollama y API-key agents pueden usar esta misma tool.",
    parameters: Type.Object({
      goal: Type.String({
        minLength: 3,
        maxLength: 500,
        description: "Meta en lenguaje natural. Sé concreto: 'abre Chrome y ve a youtube.com' es mejor que 'pon música'.",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("simulate"), Type.Literal("production")], {
          default: "production",
          description: "simulate = decide pero NO dispatcha (preview). production = ejecuta de verdad.",
        }),
      ),
      maxIterations: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, default: 8, description: "Hard ceiling on loop iterations." }),
      ),
      interStepDelayMs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 2_000, default: 250, description: "Pausa entre steps para que la UI se asiente." }),
      ),
      preferBrowser: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Forzar el uso de browser_* tools (cuando la foreground no es browser pero el goal es web).",
        }),
      ),
      brainProvider: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("gemini"),
            Type.Literal("openai"),
            Type.Literal("anthropic"),
            Type.Literal("ollama"),
          ],
          {
            default: "auto",
            description:
              "Proveedor interno para el paso think. auto usa el fallback configurado; ollama permite Gemma4/Ollama Cloud.",
          },
        ),
      ),
      brainModel: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 120,
          description: "Modelo opcional para el brain interno, por ejemplo gemma4:31b o gemini-2.5-flash.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as {
        goal: string;
        mode?: "simulate" | "production";
        maxIterations?: number;
        interStepDelayMs?: number;
        preferBrowser?: boolean;
        brainProvider?: BrainProviderName;
        brainModel?: string;
      };
      const goal = params.goal?.trim();
      if (!goal) throw new ToolInputError("goal is required");
      const run = await engine.run({
        goal,
        mode: params.mode,
        maxIterations: params.maxIterations,
        interStepDelayMs: params.interStepDelayMs,
        preferBrowser: params.preferBrowser,
        brainProvider: params.brainProvider,
        brainModel: params.brainModel,
      });
      return jsonResult(summarizeRun(run));
    },
  };
}

export function createPcDoStatusTool(engine: PcOperatorEngine): AnyAgentTool {
  return {
    name: "lumina_pc_do_status",
    label: "Lumina PC — Do Status",
    description: "Devuelve el estado + trace completa de un run previo de lumina_pc_do.",
    parameters: Type.Object({
      runId: Type.String({ minLength: 4, maxLength: 80 }),
    }),
    async execute(_id, raw) {
      const params = raw as { runId: string };
      return jsonResult(summarizeRun(engine.get(params.runId)));
    },
  };
}

export function createPcDoListTool(engine: PcOperatorEngine): AnyAgentTool {
  return {
    name: "lumina_pc_do_list",
    label: "Lumina PC — Do List",
    description: "Lista todos los runs de lumina_pc_do en esta sesión del gateway.",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({
        ok: true,
        runs: engine.list().map((r) => ({
          id: r.id,
          goal: r.goal,
          status: r.status,
          mode: r.mode,
          requestedBrainProvider: r.requestedBrainProvider,
          requestedBrainModel: r.requestedBrainModel,
          createdAtISO: r.createdAtISO,
          finishedAtISO: r.finishedAtISO,
          stepCount: r.steps.length,
        })),
      });
    },
  };
}

export function createPcDoAbortTool(engine: PcOperatorEngine): AnyAgentTool {
  return {
    name: "lumina_pc_do_abort",
    label: "Lumina PC — Do Abort",
    description:
      "Marca un run en curso para abortarse al inicio de la siguiente iteración. " +
      "Cooperativo — no mata mid-dispatch.",
    parameters: Type.Object({
      runId: Type.String({ minLength: 4, maxLength: 80 }),
    }),
    async execute(_id, raw) {
      const params = raw as { runId: string };
      const ok = engine.abort(params.runId);
      return jsonResult({ ok, runId: params.runId });
    },
  };
}

export function createPcDoSkillHealthTool(tracker: SkillHealthTracker): AnyAgentTool {
  return {
    name: "lumina_pc_do_skill_health",
    label: "Lumina PC — Skill Health",
    description:
      "Devuelve el estado de salud de las skills aprendidas (learned-*) según las ejecuciones recientes " +
      "en lumina_pc_do. Pasa `flaggedOnly: true` para ver solo las que llevan ≥3 fallos seguidos " +
      "(self-healing flag). Util para responder 'qué skills están rotas' o sugerir regrabaciones.",
    parameters: Type.Object({
      flaggedOnly: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, raw) {
      const params = raw as { flaggedOnly?: boolean };
      return jsonResult({
        ok: true,
        skills: tracker.snapshot({ flaggedOnly: params.flaggedOnly }),
      });
    },
  };
}

export function createPcDoSkillResetTool(tracker: SkillHealthTracker): AnyAgentTool {
  return {
    name: "lumina_pc_do_skill_reset",
    label: "Lumina PC — Skill Reset",
    description:
      "Olvida el histórico de salud de UNA skill aprendida (e.g. después de que Dal la regrabó). " +
      "Útil porque self-healing flag persiste in-memory hasta que ves un success o llamas a este reset.",
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1, maxLength: 120 }),
    }),
    async execute(_id, raw) {
      const params = raw as { skillName: string };
      const reset = tracker.reset(params.skillName);
      return jsonResult({ ok: true, skillName: params.skillName, reset });
    },
  };
}

export function createPcDoCostSummaryTool(meter: CostMeter): AnyAgentTool {
  return {
    name: "lumina_pc_do_cost_summary",
    label: "Lumina PC — Cost Summary",
    description:
      "Devuelve el gasto acumulado en tokens + USD del PC Operator Loop desde el arranque del gateway. " +
      "Útil para responder a Dal '¿cuánto te has gastado hoy?'. Pasar `windowSeconds` para ventana " +
      "(e.g. 3600 = última hora). Default: todo. Devuelve `byProvider` con totales por par provider/model " +
      "y `recent` con los últimos N entries.",
    parameters: Type.Object({
      windowSeconds: Type.Optional(
        Type.Integer({
          minimum: 60,
          maximum: 30 * 24 * 3600,
          description: "Ventana en segundos para filtrar (default: desde el arranque).",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, default: 20 }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { windowSeconds?: number; limit?: number };
      return jsonResult(meter.summary({ windowSeconds: params.windowSeconds, limit: params.limit }));
    },
  };
}
