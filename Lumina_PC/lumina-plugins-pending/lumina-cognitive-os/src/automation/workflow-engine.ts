/**
 * workflow-engine.ts — Spec 1: Macro-secuencias (Recetas).
 *
 * Loads user-editable workflow recipes from JSON files in
 * `c:/I24D_WhatsApp/recipes/` (override with LUMINA_RECIPES_DIR) and
 * exposes a deterministic plan derived from them. Each step can declare:
 *
 *   - tool         (required) tool name registered in OpenClaw
 *   - params       (required) JSON object passed verbatim to the tool
 *   - description  (optional) one-liner for the Transparency panel
 *   - precondition (optional) state check that may SKIP the step:
 *       { type: "process_running", name: "spotify" }
 *       { type: "window_title_contains", needle: "Visual Studio Code" }
 *       { type: "always" }
 *   - idempotent   (optional) hint for the engine — currently advisory
 *   - stopOnError  (optional) override the recipe-level default
 *
 * The engine ITSELF does not execute tool calls — that's the agent's
 * job (so existing approval/audit semantics keep applying). Instead it
 * resolves the recipe into a list of {action, params, skip, reason}
 * which the agent walks, and it auto-logs every resolution to the
 * action log (Spec 3).
 */
import fs from "node:fs";
import path from "node:path";
import type { ActionLogStore } from "../memory/action-log.js";
import { getLuminaEnvVar } from "../env.js";

export type PreconditionAlways = { readonly type: "always" };
export type PreconditionProcessRunning = { readonly type: "process_running"; readonly name: string };
export type PreconditionWindowTitleContains = {
  readonly type: "window_title_contains";
  readonly needle: string;
};
export type PreconditionWindowMissing = {
  readonly type: "window_missing";
  readonly needle: string;
};
export type Precondition =
  | PreconditionAlways
  | PreconditionProcessRunning
  | PreconditionWindowTitleContains
  | PreconditionWindowMissing;

export type RecipeStep = {
  readonly tool: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly precondition?: Precondition;
  readonly idempotent?: boolean;
  readonly stopOnError?: boolean;
};

export type Recipe = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly triggers: ReadonlyArray<string>;
  readonly stopOnError: boolean;
  readonly steps: ReadonlyArray<RecipeStep>;
  readonly sourcePath: string;
};

export type ResolvedStep = {
  readonly index: number;
  readonly tool: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly skip: boolean;
  readonly skipReason?: string;
  readonly idempotent: boolean;
  readonly stopOnError: boolean;
};

export type ResolvedPlan = {
  readonly recipe: Recipe;
  readonly resolvedAtISO: string;
  readonly steps: ReadonlyArray<ResolvedStep>;
  readonly anyExecutable: boolean;
};

/** Live state passed into the engine when resolving — provided by the
 *  caller from cached awareness so we don't shell out per resolution.
 *  Distinct from awareness/snapshot.ts EnvironmentSnapshot (CPU/RAM/disks). */
export type WorkflowEnvironment = {
  readonly runningProcessNames: ReadonlySet<string>;
  readonly visibleWindowTitles: ReadonlyArray<string>;
};

const DEFAULT_RECIPES_DIR = "c:/I24D_WhatsApp/recipes";

export function resolveRecipesDir(override?: string): string {
  if (override && override.trim()) return override.trim();
  const env = getLuminaEnvVar("LUMINA_RECIPES_DIR");
  return env && env.trim() ? env.trim() : DEFAULT_RECIPES_DIR;
}

function safeId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function parsePrecondition(raw: unknown): Precondition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "always") return { type: "always" };
  if (type === "process_running" && typeof obj.name === "string") {
    return { type: "process_running", name: obj.name.trim() };
  }
  if (type === "window_title_contains" && typeof obj.needle === "string") {
    return { type: "window_title_contains", needle: obj.needle.trim() };
  }
  if (type === "window_missing" && typeof obj.needle === "string") {
    return { type: "window_missing", needle: obj.needle.trim() };
  }
  return undefined;
}

function parseSteps(raw: unknown): RecipeStep[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const tool = typeof s.tool === "string" ? s.tool.trim() : "";
    if (!tool) continue;
    const params =
      s.params && typeof s.params === "object" && !Array.isArray(s.params)
        ? (s.params as Record<string, unknown>)
        : {};
    out.push({
      tool,
      params,
      description: typeof s.description === "string" ? s.description.trim() : undefined,
      precondition: parsePrecondition(s.precondition),
      idempotent: s.idempotent === true,
      stopOnError: typeof s.stopOnError === "boolean" ? s.stopOnError : undefined,
    });
  }
  return out;
}

function parseRecipe(filePath: string, raw: unknown): Recipe | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const fallbackId = safeId(path.basename(filePath).replace(/\.json$/i, ""));
  const id = safeId(obj.id) || fallbackId;
  if (!id) return null;
  const steps = parseSteps(obj.steps);
  if (steps.length === 0) return null;
  return {
    id,
    displayName: typeof obj.displayName === "string" ? obj.displayName : id,
    description: typeof obj.description === "string" ? obj.description : "",
    triggers: Array.isArray(obj.triggers)
      ? (obj.triggers.filter((t): t is string => typeof t === "string"))
      : [],
    stopOnError: obj.stopOnError !== false,
    steps,
    sourcePath: filePath,
  };
}

export class WorkflowEngine {
  private readonly recipesDir: string;
  private readonly log: ActionLogStore | null;
  private cache: Map<string, Recipe> = new Map();
  private lastLoadedAtMs = 0;
  private readonly reloadEveryMs = 5_000;

  constructor(params: { recipesDir?: string; log?: ActionLogStore | null }) {
    this.recipesDir = resolveRecipesDir(params.recipesDir);
    this.log = params.log ?? null;
    this.reloadIfStale(true);
  }

  private reloadIfStale(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastLoadedAtMs < this.reloadEveryMs) return;
    this.lastLoadedAtMs = now;
    const next = new Map<string, Recipe>();
    if (!fs.existsSync(this.recipesDir)) {
      this.cache = next;
      return;
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.recipesDir);
    } catch {
      this.cache = next;
      return;
    }
    for (const name of entries) {
      if (!/\.json$/i.test(name)) continue;
      const full = path.join(this.recipesDir, name);
      try {
        const raw = fs.readFileSync(full, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const recipe = parseRecipe(full, parsed);
        if (recipe) next.set(recipe.id, recipe);
      } catch {
        /* ignore corrupt recipe */
      }
    }
    this.cache = next;
  }

  list(): Recipe[] {
    this.reloadIfStale();
    return Array.from(this.cache.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): Recipe | null {
    this.reloadIfStale();
    return this.cache.get(safeId(id)) ?? null;
  }

  recipesDirForDebug(): string {
    return this.recipesDir;
  }

  /** Resolve a recipe against an environment snapshot. Marks each step
   *  as skip/execute and emits an action-log entry per skipped step so
   *  the user has a trail of "Spotify ya estaba abierto, no lo lancé". */
  resolve(recipe: Recipe, env: WorkflowEnvironment): ResolvedPlan {
    const steps: ResolvedStep[] = recipe.steps.map((step, index) => {
      const evaluation = evaluatePrecondition(step.precondition, env);
      const resolved: ResolvedStep = {
        index,
        tool: step.tool,
        params: step.params,
        description: step.description ?? `${step.tool} step ${index + 1}`,
        skip: evaluation.skip,
        skipReason: evaluation.reason,
        idempotent: step.idempotent ?? false,
        stopOnError: step.stopOnError ?? recipe.stopOnError,
      };
      if (resolved.skip && this.log) {
        this.log.append({
          action: "workflow.step.skip",
          target: `${recipe.id}#${index + 1}:${step.tool}`,
          result: "skipped",
          detail: evaluation.reason,
          source: "workflow-engine",
        });
      }
      return resolved;
    });
    if (this.log) {
      this.log.append({
        action: "workflow.resolve",
        target: `recipe:${recipe.id}`,
        result: "ok",
        detail: `${steps.filter((s) => !s.skip).length}/${steps.length} steps to run`,
        source: "workflow-engine",
        extra: { displayName: recipe.displayName },
      });
    }
    return {
      recipe,
      resolvedAtISO: new Date().toISOString(),
      steps,
      anyExecutable: steps.some((s) => !s.skip),
    };
  }
}

function evaluatePrecondition(
  precondition: Precondition | undefined,
  env: WorkflowEnvironment,
): { skip: boolean; reason?: string } {
  if (!precondition || precondition.type === "always") return { skip: false };
  if (precondition.type === "process_running") {
    const target = precondition.name.toLowerCase().replace(/\.exe$/, "");
    const running = Array.from(env.runningProcessNames).some(
      (n) => n.toLowerCase().replace(/\.exe$/, "") === target,
    );
    return running ? { skip: true, reason: `process '${precondition.name}' already running` } : { skip: false };
  }
  if (precondition.type === "window_title_contains") {
    const needle = precondition.needle.toLowerCase();
    const hit = env.visibleWindowTitles.some((t) => t.toLowerCase().includes(needle));
    return hit ? { skip: true, reason: `window matching '${precondition.needle}' already visible` } : { skip: false };
  }
  if (precondition.type === "window_missing") {
    const needle = precondition.needle.toLowerCase();
    const hit = env.visibleWindowTitles.some((t) => t.toLowerCase().includes(needle));
    return hit ? { skip: false } : { skip: true, reason: `no window matching '${precondition.needle}'` };
  }
  return { skip: false };
}
