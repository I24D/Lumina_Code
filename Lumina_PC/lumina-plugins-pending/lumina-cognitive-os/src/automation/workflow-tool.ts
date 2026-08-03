/**
 * workflow-tool.ts — Agent tools for the workflow (recipe) engine.
 *
 *   lumina_workflow_list  — show available recipes
 *   lumina_workflow_run   — resolve a recipe into an executable plan
 *                           (the AGENT walks the plan and calls each
 *                            step's tool, so existing approval/audit
 *                            semantics stay intact)
 *
 * Recipes live as JSON in c:/I24D_WhatsApp/recipes/ — the user can edit
 * them by hand. Override directory with LUMINA_RECIPES_DIR.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import type { WorkflowEngine, WorkflowEnvironment } from "./workflow-engine.js";

export type WorkflowEnvironmentProvider = () => Promise<WorkflowEnvironment> | WorkflowEnvironment;

export function createWorkflowListTool(engine: WorkflowEngine): AnyAgentTool {
  return {
    name: "lumina_workflow_list",
    label: "Lumina Workflow — List Recipes",
    description:
      "Lists all user-editable recipes available in c:/I24D_WhatsApp/recipes/. Each recipe is a named " +
      "sequence of tool calls with optional preconditions (skip step if already done). Call this when the " +
      "user asks 'qué recetas tienes?' or before suggesting a workflow.",
    parameters: Type.Object({}),
    async execute() {
      const recipes = engine.list().map((r) => ({
        id: r.id,
        displayName: r.displayName,
        description: r.description,
        triggers: r.triggers,
        stepCount: r.steps.length,
        sourcePath: r.sourcePath,
      }));
      return jsonResult({
        ok: true,
        recipesDir: engine.recipesDirForDebug(),
        count: recipes.length,
        recipes,
      });
    },
  };
}

export function createWorkflowRunTool(
  engine: WorkflowEngine,
  snapshotProvider: WorkflowEnvironmentProvider,
): AnyAgentTool {
  return {
    name: "lumina_workflow_run",
    label: "Lumina Workflow — Resolve Recipe",
    description:
      "Resolves a named recipe against the current environment (running processes, visible windows) and " +
      "returns the ordered list of steps to execute. Each step says whether to RUN it or SKIP (e.g. 'Spotify " +
      "already open'). YOU (the agent) then walk the returned steps and call each tool yourself, so user " +
      "approval flows still apply. Returns the resolved plan; does NOT execute steps.",
    parameters: Type.Object({
      recipeId: Type.String({ minLength: 1, maxLength: 80 }),
    }),
    async execute(_id, params) {
      const id = params.recipeId?.trim();
      if (!id) throw new ToolInputError("recipeId is required");
      const recipe = engine.get(id);
      if (!recipe) {
        return jsonResult({
          ok: false,
          error: `recipe '${id}' not found`,
          hint: `Call lumina_workflow_list to see what's available, or drop a JSON file into ${engine.recipesDirForDebug()}`,
        });
      }
      const env = await snapshotProvider();
      const plan = engine.resolve(recipe, env);
      return jsonResult({
        ok: true,
        recipeId: recipe.id,
        displayName: recipe.displayName,
        description: recipe.description,
        anyExecutable: plan.anyExecutable,
        resolvedAtISO: plan.resolvedAtISO,
        steps: plan.steps.map((s) => ({
          index: s.index + 1,
          tool: s.tool,
          params: s.params,
          description: s.description,
          action: s.skip ? "SKIP" : "RUN",
          skipReason: s.skipReason,
          stopOnError: s.stopOnError,
        })),
      });
    },
  };
}
