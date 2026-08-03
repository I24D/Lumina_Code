/**
 * loop-engine.ts — PC Operator Loop orchestrator.
 *
 * The headline of "Camino A". For a goal like "abre YouTube y reproduce
 * Despacito" this engine drives the entire observe→think→act→verify→repeat
 * loop internally so the host agent (Lumina/Gemini Live/Claude) only makes
 * ONE tool call.
 *
 *   PcOperatorEngine.run({ goal })
 *     │
 *     ├── observe()                    pc_observe + (if browser) browser_dom_observe
 *     ├── brain.think({...})           Gemini multimodal returns next LoopAction
 *     ├── dispatchAction(action)       routes to smart_click / smart_type / scroll / ...
 *     ├── append step to history
 *     ├── append to action log (audit)
 *     ├── emit progress toast (optional)
 *     └── repeat until { done | stuck | abort | maxIterations }
 *
 * The engine is pure orchestration — every "side effect" (UIA read, Bridge
 * call, LLM call) is injected via deps so tests can mock everything.
 */
import type { ActionLogStore } from "../memory/action-log.js";
import type { BridgeClient } from "../shared/bridge-client.js";
import { dispatchAction, type DispatchResult, type ToolRegistry } from "./action-dispatcher.js";
import { killSwitch } from "./kill-switch.js";
import { classifyWindow } from "../vision/window-classify.js";
import type {
  BrainClient,
  BrainProviderName,
  LoopAction,
  ObservationDigest,
  StepHistoryEntry,
} from "./brain-gemini.js";
import type { CostMeter } from "./cost-meter.js";

export type LoopMode = "simulate" | "production";

export type LoopRunStatus = "pending" | "running" | "done" | "stuck" | "aborted" | "max_iterations" | "error";

export type LoopStep = {
  readonly iteration: number;
  readonly atISO: string;
  readonly latencyMs: number;
  readonly observation: ObservationDigest;
  readonly screenshotPath: string | null;
  readonly action: LoopAction;
  readonly dispatch: DispatchResult | null;
  readonly thinkMs?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly brainProvider?: Exclude<BrainProviderName, "auto">;
  readonly brainModel?: string;
};

export type LoopRun = {
  readonly id: string;
  readonly goal: string;
  readonly mode: LoopMode;
  readonly requestedBrainProvider?: BrainProviderName;
  readonly requestedBrainModel?: string;
  readonly createdAtISO: string;
  startedAtISO?: string;
  finishedAtISO?: string;
  status: LoopRunStatus;
  abortRequested: boolean;
  readonly steps: LoopStep[];
  finalSummary?: string;
  stuckReason?: string;
  errorMessage?: string;
};

// Browser/Electron detection moved into vision/window-classify.ts (§3 router)
// so one classifier drives the native-vs-CDP-vs-vision decision everywhere.

export type ObserveResult = {
  readonly screenshotPath: string | null;
  readonly digest: ObservationDigest;
  readonly freshnessMs?: number | null;
};

export type PassiveVerification = {
  readonly method: "observation-delta";
  /** True when the observation changed enough to plausibly credit the
   * previous action for the change (screenshot path renewed, foreground
   * process switched, interactable set materially different). */
  readonly changed: boolean;
  readonly changedFields: ReadonlyArray<
    "screenshotPath" | "foregroundProcess" | "interactablesCount" | "windowTitles"
  >;
};

/**
 * Silent post-action check. Alexa/Siri-grade UX needs Lumina to know if
 * "the video started playing" without asking the user. This util compares
 * two consecutive observations and returns whether a meaningful change
 * happened. The loop uses it to fill DispatchResult.verifiedByTool when
 * the underlying tool did not answer the question itself.
 */
export function verifyObservationDelta(
  before: ObserveResult,
  after: ObserveResult,
): PassiveVerification {
  const changedFields: PassiveVerification["changedFields"][number][] = [];
  if (before.screenshotPath !== after.screenshotPath) changedFields.push("screenshotPath");
  const beforeFresh = before.freshnessMs ?? null;
  const afterFresh = after.freshnessMs ?? null;
  if (beforeFresh !== null && afterFresh !== null && Math.abs(beforeFresh - afterFresh) > 500) {
    if (!changedFields.includes("screenshotPath")) changedFields.push("screenshotPath");
  }
  if (before.digest.foregroundProcess !== after.digest.foregroundProcess) {
    changedFields.push("foregroundProcess");
  }
  const beforeCount = before.digest.interactables?.length ?? 0;
  const afterCount = after.digest.interactables?.length ?? 0;
  if (Math.abs(beforeCount - afterCount) >= 2) changedFields.push("interactablesCount");
  const beforeTitles = (before.digest.windowTitles ?? []).join("|");
  const afterTitles = (after.digest.windowTitles ?? []).join("|");
  if (beforeTitles !== afterTitles) changedFields.push("windowTitles");
  return {
    method: "observation-delta",
    changed: changedFields.length > 0,
    changedFields,
  };
}

export type Observer = () => Promise<ObserveResult>;

/** Injected skill-catalog reader. Kept as an interface so the loop
 * engine does not import SkillLoader directly (avoids a cyclic import
 * between operator/ and skills/). Any object with these two methods
 * works — including a tiny in-memory stub for tests. */
export type SkillCatalog = {
  list(): ReadonlyArray<{ readonly id: string; readonly description: string }>;
};

/** Called when the loop matched a skill for the goal and delegated
 * execution. `ok` reflects whether the skill run completed cleanly.
 * `summary` becomes the LoopRun.finalSummary. */
export type SkillRunner = (params: {
  readonly skillId: string;
  readonly goal: string;
  readonly runId: string;
}) => Promise<{ readonly ok: boolean; readonly summary: string }>;

export type LoopEngineDeps = {
  readonly brain: BrainClient;
  readonly tools: ToolRegistry;
  readonly bridge: BridgeClient;
  readonly allowedApps: ReadonlyArray<string>;
  readonly log?: ActionLogStore | null;
  readonly observer?: Observer; // override for tests
  readonly notifyToast?: ((message: string) => void) | null;
  readonly costMeter?: CostMeter | null;
  readonly onLearnedSkillResult?: ((params: { skillName: string; ok: boolean; verified: boolean | null; runId: string; iteration: number }) => void) | null;
  /** Skill-first shortcut: when set, the loop consults this catalog
   * before entering think/act. If the goal matches a skill above the
   * `skillMatchThreshold`, the loop delegates to `skillRunner` and
   * returns. When null/undefined the loop runs the classic think/act
   * cycle. */
  readonly skillCatalog?: SkillCatalog | null;
  readonly skillRunner?: SkillRunner | null;
  /** 0..1 — minimum Jaccard overlap between goal tokens and skill
   *  (id + description) tokens to consider a match. Default 0.4. */
  readonly skillMatchThreshold?: number;
  /** Optional callback fired after a successful loop finishes so the
   * host can offer to save the trace as a new skill (Demo → Skill). */
  readonly onLoopSuccess?: ((params: {
    readonly runId: string;
    readonly goal: string;
    readonly finalSummary: string | undefined;
    readonly stepCount: number;
  }) => void) | null;
};

const SKILL_STOPWORDS = new Set<string>([
  "el", "la", "los", "las", "un", "una", "y", "o", "de", "del", "en", "por", "para", "con",
  "the", "a", "an", "and", "or", "of", "in", "on", "to", "for", "with", "at",
  "me", "mi", "tu", "su", "sus", "mis",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{Letter}\p{Number}]+/u)) {
    if (raw.length < 3) continue;
    if (SKILL_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Jaccard similarity between the goal and a skill's (id + description).
 * The metric is intentionally simple: no embeddings, no LLM call — Fase C
 * has to stay well under 50ms so the shortcut feels instant. */
export function scoreSkillMatch(
  goal: string,
  skill: { id: string; description: string },
): number {
  const goalTokens = tokenize(goal);
  const skillTokens = tokenize(`${skill.id.replace(/-/g, " ")} ${skill.description}`);
  if (goalTokens.size === 0 || skillTokens.size === 0) return 0;
  let inter = 0;
  for (const t of goalTokens) if (skillTokens.has(t)) inter += 1;
  const union = new Set([...goalTokens, ...skillTokens]).size;
  return union === 0 ? 0 : inter / union;
}

/** Find the best-matching skill for `goal`. Returns null if nothing
 * scores above `threshold`. */
export function pickSkillForGoal(
  goal: string,
  catalog: SkillCatalog,
  threshold: number,
): { readonly skillId: string; readonly score: number } | null {
  let bestId: string | null = null;
  let bestScore = 0;
  for (const skill of catalog.list()) {
    const score = scoreSkillMatch(goal, skill);
    if (score > bestScore) {
      bestScore = score;
      bestId = skill.id;
    }
  }
  if (bestId === null || bestScore < threshold) return null;
  return { skillId: bestId, score: bestScore };
}

export type RunParams = {
  readonly goal: string;
  readonly mode?: LoopMode;
  readonly maxIterations?: number;
  readonly interStepDelayMs?: number;
  readonly preferBrowser?: boolean;
  readonly brainProvider?: BrainProviderName;
  readonly brainModel?: string;
  readonly onStep?: (step: LoopStep, run: LoopRun) => void;
};

let RUN_COUNTER = 0;
function newRunId(): string {
  RUN_COUNTER += 1;
  return `pcdo-${String(performance.now()).replace(".", "")}-${RUN_COUNTER}`;
}

// Smart-click queries that target a learned skill carry the skill name as
// the query (the brain prompts "smart_click({ query: 'learned-spotify-play' })").
// Detect them to feed the self-healing tracker.
function extractLearnedSkillName(query: string | undefined): string | null {
  if (!query) return null;
  const trimmed = query.trim().toLowerCase();
  if (trimmed.startsWith("learned-")) return trimmed.split(/\s+/u)[0]!;
  return null;
}

export class PcOperatorEngine {
  private readonly deps: LoopEngineDeps;
  private readonly runs = new Map<string, LoopRun>();

  constructor(deps: LoopEngineDeps) {
    this.deps = deps;
  }

  list(): ReadonlyArray<LoopRun> {
    return Array.from(this.runs.values()).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO));
  }

  get(id: string): LoopRun | null {
    return this.runs.get(id) ?? null;
  }

  abort(id: string): boolean {
    const r = this.runs.get(id);
    if (!r) return false;
    if (r.status === "done" || r.status === "aborted" || r.status === "error" || r.status === "stuck" || r.status === "max_iterations") {
      return false;
    }
    r.abortRequested = true;
    return true;
  }

  async run(params: RunParams): Promise<LoopRun> {
    const goal = params.goal.trim();
    if (!goal) throw new Error("goal is required");
    const mode: LoopMode = params.mode ?? "production";
    const maxIterations = Math.max(1, Math.min(20, params.maxIterations ?? 8));
    const interStepDelayMs = Math.max(0, Math.min(2_000, params.interStepDelayMs ?? 250));

    const run: LoopRun = {
      id: newRunId(),
      goal,
      mode,
      requestedBrainProvider: params.brainProvider,
      requestedBrainModel: params.brainModel,
      createdAtISO: new Date().toISOString(),
      status: "pending",
      abortRequested: false,
      steps: [],
    };
    this.runs.set(run.id, run);

    run.status = "running";
    run.startedAtISO = new Date().toISOString();
    this.deps.log?.append({
      action: "pc_operator.start",
      target: run.id,
      result: "ok",
      detail: `goal="${goal}" mode=${mode} max=${maxIterations}`,
      source: "pc-operator",
      extra: { goal, mode, maxIterations },
    });
    this.deps.notifyToast?.(`Lumina opera: "${goal}"`);

    // ── Skill-first shortcut ─────────────────────────────────────────
    // If the operator has a skills catalog and one matches the goal
    // above threshold, delegate to it and skip the whole think/act
    // cascade. This is the "Alexa recipe" path — 10× faster than a
    // multi-step visual loop for tasks the user has already taught.
    if (mode === "production" && this.deps.skillCatalog && this.deps.skillRunner) {
      const threshold = this.deps.skillMatchThreshold ?? 0.4;
      const match = pickSkillForGoal(goal, this.deps.skillCatalog, threshold);
      if (match) {
        try {
          const outcome = await this.deps.skillRunner({
            skillId: match.skillId,
            goal,
            runId: run.id,
          });
          run.status = outcome.ok ? "done" : "error";
          run.finalSummary = outcome.summary;
          if (!outcome.ok) run.errorMessage = outcome.summary;
          run.finishedAtISO = new Date().toISOString();
          this.deps.log?.append({
            action: "pc_operator.skill_shortcut",
            target: run.id,
            result: outcome.ok ? "ok" : "error",
            detail: `skill=${match.skillId} score=${match.score.toFixed(2)}`,
            source: "pc-operator",
            extra: { skillId: match.skillId, score: match.score, goal },
          });
          this.deps.notifyToast?.(
            outcome.ok
              ? `Lumina usó la receta: ${match.skillId}`
              : `Receta ${match.skillId} falló, reintenta manual`,
          );
          if (outcome.ok) {
            this.deps.onLoopSuccess?.({
              runId: run.id,
              goal,
              finalSummary: run.finalSummary,
              stepCount: 0,
            });
          }
          return run;
        } catch (err) {
          // Skill delegation crashed — fall through to the classic
          // think/act loop. Don't lose the goal because a recipe was
          // faulty. Log so we can find & fix the broken skill later.
          this.deps.log?.append({
            action: "pc_operator.skill_shortcut_failed",
            target: run.id,
            result: "error",
            detail: `skill=${match.skillId} err=${err instanceof Error ? err.message : String(err)}`,
            source: "pc-operator",
          });
        }
      }
    }

    const history: StepHistoryEntry[] = [];

    try {
      for (let iter = 1; iter <= maxIterations; iter++) {
        // Global kill switch (§9) freezes every run, not just this one — check
        // it alongside the per-run abort flag at each iteration boundary.
        const killed = killSwitch.isEngaged();
        if (run.abortRequested || killed) {
          run.status = "aborted";
          run.finishedAtISO = new Date().toISOString();
          this.deps.log?.append({
            action: killed ? "pc_operator.kill_switch" : "pc_operator.aborted",
            target: run.id,
            result: "skipped",
            detail: killed
              ? `kill switch engaged (${killSwitch.getState().reason ?? "manual"}) at iter ${iter - 1}`
              : `aborted at iter ${iter - 1}`,
            source: "pc-operator",
          });
          break;
        }

        const t0 = performance.now();
        const observeResult = await this.observe(params.preferBrowser);
        const obsMs = performance.now() - t0;

        const t1 = performance.now();
        const think = await this.deps.brain.think({
          goal,
          iteration: iter,
          maxIterations,
          observation: observeResult.digest,
          screenshotPath: observeResult.screenshotPath,
          history,
          brainProvider: params.brainProvider,
          brainModel: params.brainModel,
        });
        const thinkMs = performance.now() - t1;

        let dispatch: DispatchResult | null = null;
        let outcome: StepHistoryEntry["outcome"] = "ok";
        let errorMessage: string | undefined;

        if (think.action.kind === "done") {
          dispatch = null;
          outcome = "ok";
        } else if (think.action.kind === "stuck") {
          dispatch = null;
          outcome = "ok";
        } else if (mode === "simulate") {
          dispatch = {
            ok: true,
            dispatched: false,
            verifiedByTool: null,
            toolName: `simulate:${think.action.kind}`,
          };
          outcome = "skipped";
        } else {
          dispatch = await dispatchAction(
            { tools: this.deps.tools, bridge: this.deps.bridge, allowedApps: this.deps.allowedApps },
            think.action,
          );
          if (!dispatch.ok) {
            outcome = "tool_error";
            errorMessage = dispatch.errorMessage;
          } else if (dispatch.verifiedByTool === false) {
            outcome = "verify_failed";
          } else {
            outcome = "ok";
          }
        }

        const step: LoopStep = {
          iteration: iter,
          atISO: new Date().toISOString(),
          latencyMs: Math.round(obsMs + thinkMs + (dispatch ? 100 : 0)),
          observation: observeResult.digest,
          screenshotPath: observeResult.screenshotPath,
          action: think.action,
          dispatch,
          thinkMs: Math.round(thinkMs),
          tokensIn: think.tokensIn,
          tokensOut: think.tokensOut,
          brainProvider: think.brainProvider,
          brainModel: think.brainModel,
        };
        run.steps.push(step);
        history.push({ iteration: iter, action: think.action, outcome, errorMessage });

        this.deps.log?.append({
          action: `pc_operator.${think.action.kind}`,
          target: run.id,
          result: outcome === "ok" ? "ok" : outcome === "skipped" ? "skipped" : "error",
          detail: `iter ${iter}: ${outcome}${errorMessage ? ` (${errorMessage})` : ""}`,
          source: "pc-operator",
          extra: {
            iteration: iter,
            actionKind: think.action.kind,
            brainProvider: think.brainProvider,
            brainModel: think.brainModel,
          },
        });

        // Cost meter — record token usage from this think() call.
        if (this.deps.costMeter && (think.tokensIn || think.tokensOut)) {
          this.deps.costMeter.record({
            runId: run.id,
            iteration: iter,
            provider: think.brainProvider ?? null,
            model: think.brainModel ?? null,
            tokensIn: think.tokensIn ?? 0,
            tokensOut: think.tokensOut ?? 0,
          });
        }

        // Self-healing — notify when a learned-* skill action fails or fails verification.
        if (this.deps.onLearnedSkillResult && dispatch) {
          const a = think.action;
          const skillName = a.kind === "smart_click" || a.kind === "smart_type"
            ? extractLearnedSkillName(a.query)
            : null;
          if (skillName) {
            this.deps.onLearnedSkillResult({
              skillName,
              ok: dispatch.ok,
              verified: dispatch.verifiedByTool,
              runId: run.id,
              iteration: iter,
            });
          }
        }
        if (this.deps.notifyToast && think.action.kind !== "wait") {
          const desc =
            think.action.kind === "done"
              ? `Listo: ${("summary" in think.action) ? think.action.summary : ""}`
              : think.action.kind === "stuck"
              ? `Atascada: ${("ask" in think.action) ? think.action.ask : ""}`
              : `Paso ${iter}: ${think.action.kind}`;
          this.deps.notifyToast(desc);
        }
        params.onStep?.(step, run);

        if (think.action.kind === "done") {
          run.status = "done";
          run.finalSummary = ("summary" in think.action) ? think.action.summary : "";
          run.finishedAtISO = new Date().toISOString();
          this.deps.log?.append({
            action: "pc_operator.done",
            target: run.id,
            result: "ok",
            detail: `done in ${iter} step(s): ${run.finalSummary}`,
            source: "pc-operator",
          });
          // Learning hook: the host may want to save the successful
          // trace as a new skill (Demo → Skill).
          this.deps.onLoopSuccess?.({
            runId: run.id,
            goal,
            finalSummary: run.finalSummary,
            stepCount: run.steps.length,
          });
          break;
        }
        if (think.action.kind === "stuck") {
          run.status = "stuck";
          run.stuckReason = ("ask" in think.action) ? think.action.ask : "no detail";
          run.finishedAtISO = new Date().toISOString();
          this.deps.log?.append({
            action: "pc_operator.stuck",
            target: run.id,
            result: "warn",
            detail: `stuck at iter ${iter}: ${run.stuckReason}`,
            source: "pc-operator",
          });
          break;
        }
        if (iter < maxIterations && interStepDelayMs > 0) {
          await new Promise((r) => setTimeout(r, interStepDelayMs));
        }
      }

      if (run.status === "running") {
        run.status = "max_iterations";
        run.finishedAtISO = new Date().toISOString();
        this.deps.log?.append({
          action: "pc_operator.max_iterations",
          target: run.id,
          result: "warn",
          detail: `exhausted ${maxIterations} iterations without 'done'`,
          source: "pc-operator",
        });
      }
    } catch (e) {
      run.status = "error";
      run.errorMessage = (e as Error).message;
      run.finishedAtISO = new Date().toISOString();
      this.deps.log?.append({
        action: "pc_operator.error",
        target: run.id,
        result: "error",
        detail: run.errorMessage ?? "unknown error",
        source: "pc-operator",
      });
    }

    return run;
  }

  private async observe(preferBrowser?: boolean): Promise<ObserveResult> {
    if (this.deps.observer) {
      return this.deps.observer();
    }
    const observeTool = this.deps.tools.pc_observe;
    if (!observeTool) {
      return { screenshotPath: null, digest: {}, freshnessMs: null };
    }
    let pcDetails: Record<string, unknown> = {};
    try {
      const r = await observeTool.execute("loop_observe", { maxInteractables: 30 });
      pcDetails = (r as unknown as { details?: Record<string, unknown> }).details ?? {};
    } catch {
      return { screenshotPath: null, digest: {}, freshnessMs: null };
    }
    const screenshotPath = typeof pcDetails.screenshotPath === "string" ? pcDetails.screenshotPath : null;
    const freshnessMs = typeof pcDetails.freshnessMs === "number" ? pcDetails.freshnessMs : null;
    const fg = pcDetails.foreground as { name?: string } | null | undefined;
    const fgProcess = fg?.name ?? null;
    const interactables = Array.isArray(pcDetails.interactables)
      ? (pcDetails.interactables as Array<Record<string, unknown>>)
      : [];
    const windows = Array.isArray(pcDetails.windows)
      ? (pcDetails.windows as Array<{ title?: string }>).map((w) => w.title ?? "")
      : [];
    // §3 router: classify the foreground window and let the class pick whether
    // the DOM (CDP) is the source of truth. Chromium browsers + Electron apps
    // are DOM-first; everything else trusts UIA, with vision as the fallback.
    const classification = classifyWindow({ processName: fgProcess ?? undefined });
    const isBrowser =
      preferBrowser === true || classification.kind === "chromium" || classification.isElectron;

    let mergedInteractables = interactables.map((i) => ({
      name: typeof i.name === "string" ? i.name : undefined,
      controlType: typeof i.controlType === "string" ? i.controlType : undefined,
      role: undefined as string | undefined,
      bbox: i.bbox as { x: number; y: number; w: number; h: number } | null | undefined,
      href: null as string | null,
    }));

    let finalScreenshotPath: string | null = screenshotPath;
    if (isBrowser && this.deps.tools.browser_dom_observe) {
      try {
        const br = await this.deps.tools.browser_dom_observe.execute("loop_observe_dom", { limit: 30 });
        const bd = (br as unknown as { details?: Record<string, unknown> }).details ?? {};
        if (bd.ok === true && Array.isArray(bd.elements)) {
          mergedInteractables = (bd.elements as Array<Record<string, unknown>>).map((e) => ({
            name: typeof e.name === "string" ? e.name : undefined,
            controlType: undefined,
            role: typeof e.role === "string" ? e.role : undefined,
            bbox: e.bbox as { x: number; y: number; w: number; h: number } | null | undefined,
            href: typeof e.href === "string" ? e.href : null,
          }));
        }
      } catch {
        // Browser observe failed — keep UIA interactables.
      }
      // Prefer the browser DOM screenshot when available: faster + always
      // captures the exact viewport the brain is going to reason about.
      if (this.deps.tools.browser_dom_screenshot) {
        try {
          const sr = await this.deps.tools.browser_dom_screenshot.execute(
            "loop_observe_dom_shot",
            {},
          );
          const sd = (sr as unknown as { details?: Record<string, unknown> }).details ?? {};
          if (sd.ok !== false && typeof sd.path === "string" && sd.path.length > 0) {
            finalScreenshotPath = sd.path;
          }
        } catch {
          // DOM screenshot failed (no Playwright session?) — keep Bridge shot.
        }
      }
    }

    // OmniParser fallback: when UIA + DOM together produced fewer than
    // 5 interactables and we still have a screenshot, ask vision_parse
    // for semantic visual elements. Typical for Electron, canvas apps
    // and games where UIA is blind. We DO NOT overwrite good UIA data —
    // we only append parse results with a fresh bbox + vision role.
    if (
      mergedInteractables.length < 5 &&
      finalScreenshotPath &&
      this.deps.tools.vision_parse
    ) {
      try {
        const vr = await this.deps.tools.vision_parse.execute("loop_observe_vision", {
          imagePath: finalScreenshotPath,
          maxElements: 40,
          setOfMarks: false,
        });
        const vd = (vr as unknown as { details?: Record<string, unknown> }).details ?? {};
        if (vd.ok !== false && Array.isArray(vd.elements)) {
          const visionExtras = (vd.elements as Array<Record<string, unknown>>)
            .filter((e) => {
              const bbox = e.bbox as { x?: number; y?: number; w?: number; h?: number } | undefined;
              return (
                bbox !== undefined &&
                typeof bbox.x === "number" &&
                typeof bbox.y === "number" &&
                typeof bbox.w === "number" &&
                typeof bbox.h === "number"
              );
            })
            .slice(0, 25)
            .map((e) => ({
              name:
                typeof e.label === "string" && e.label.length > 0
                  ? e.label
                  : typeof e.text === "string"
                  ? e.text
                  : undefined,
              controlType: undefined,
              role: typeof e.type === "string" ? `vision:${e.type}` : "vision:element",
              bbox: e.bbox as { x: number; y: number; w: number; h: number },
              href: null as string | null,
            }));
          mergedInteractables = mergedInteractables.concat(visionExtras);
        }
      } catch {
        // OmniParser sidecar unavailable or weights missing — silent
        // per the design of the tool ("returns ok=false with a hint").
      }
    }

    return {
      screenshotPath: finalScreenshotPath,
      freshnessMs,
      digest: {
        foregroundProcess: fgProcess,
        foregroundTitle: null,
        isBrowser,
        interactables: mergedInteractables,
        windowTitles: windows.filter((w) => w.length > 0),
      },
    };
  }
}
