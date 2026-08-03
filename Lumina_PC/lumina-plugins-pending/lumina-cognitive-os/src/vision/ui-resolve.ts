/**
 * ui-resolve.ts — Tool: lumina_vision_ui_resolve
 *
 * Natural-language → exact UI element resolver. Bridges the gap between
 * "haz click en el botón Guardar" and (x, y) coordinates that
 * lumina_input_control / Bridge.input_control understand.
 *
 * Backed by `uia_tree.py --find "<query>"`, which fuzzy-matches against
 * Name/AutomationId/ClassName of every interactable node in the
 * foreground window's UI Automation tree and returns the top candidates
 * with bbox + center, scored 0..1.
 *
 * Typical use:
 *   1. Agent calls lumina_vision_ui_resolve({ query: "Guardar" })
 *   2. Picks matches[0] (highest score). If score < 0.5, ask the user
 *      to clarify or fall back to lumina_vision_ui_tree for context.
 *   3. Uses matches[0].center.{x,y} with lumina_input_control
 *      mouse_click action.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

type ResolveResult = {
  ok: boolean;
  mode?: "find";
  query?: string;
  controlTypeFilter?: string | null;
  process?: { pid: number | null; name: string; className: string };
  matches?: Array<{
    name: string;
    automationId: string;
    controlType: string;
    className: string;
    bbox: { x: number; y: number; w: number; h: number } | null;
    center: { x: number; y: number } | null;
    enabled: boolean;
    offscreen: boolean;
    score: number;
  }>;
  matchCount?: number;
  nodesScanned?: number;
  error?: string;
};

export function createUiResolveTool(): AnyAgentTool {
  return {
    name: "lumina_vision_ui_resolve",
    label: "Lumina Vision — UI Resolver",
    description:
      "Resolves a natural-language description ('Guardar', 'Submit button', 'campo email') to one or more " +
      "concrete UI elements in the foreground window. Returns each candidate with automationId, controlType, " +
      "className, bbox and CENTER coordinates ready to click. Call this BEFORE lumina_input_control when you " +
      "need to click/type on a specific control. If the top score is below 0.5, ask the user to clarify or " +
      "fall back to lumina_vision_ui_tree to inspect the full tree.",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Natural-language label of the element to find (e.g. 'Guardar', 'campo de búsqueda').",
      }),
      controlType: Type.Optional(
        Type.String({
          maxLength: 40,
          description: "Optional UIA ControlType filter: Button, Edit, Hyperlink, MenuItem, CheckBox, ComboBox, ...",
        }),
      ),
      pid: Type.Optional(
        Type.Number({ description: "Optional PID; defaults to the foreground window." }),
      ),
      maxMatches: Type.Optional(
        Type.Number({ minimum: 1, maximum: 20, default: 5 }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ minimum: 1, maximum: 12, default: 8 }),
      ),
      maxNodes: Type.Optional(
        Type.Number({ minimum: 50, maximum: 2000, default: 600 }),
      ),
    }),
    async execute(_id, params) {
      const query = params.query?.trim();
      if (!query) throw new ToolInputError("query is required");

      const args: string[] = ["--find", query];
      if (typeof params.pid === "number") args.push("--pid", String(params.pid));
      if (typeof params.maxDepth === "number") args.push("--max-depth", String(params.maxDepth));
      if (typeof params.maxNodes === "number") args.push("--max-nodes", String(params.maxNodes));
      if (typeof params.maxMatches === "number") args.push("--max-matches", String(params.maxMatches));
      if (typeof params.controlType === "string" && params.controlType.trim()) {
        args.push("--control-type", params.controlType.trim());
      }

      const r = await runPythonSidecarJson<ResolveResult>("uia_tree", args, { timeoutMs: 20_000 });
      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint:
            "Make sure Python is on PATH and run: pip install uiautomation. " +
            "Alternative: rely on lumina_vision_ui_tree + lumina_screen_capture for read-only context.",
        });
      }
      const data = r.data ?? { ok: false };
      const matches = data.matches ?? [];
      const topScore = matches.length > 0 ? matches[0]!.score : 0;
      return jsonResult({
        ok: true,
        query,
        process: data.process ?? null,
        matches,
        matchCount: matches.length,
        nodesScanned: data.nodesScanned ?? 0,
        topScore,
        confident: topScore >= 0.7,
        ambiguous: matches.length >= 2 && matches[0]!.score - matches[1]!.score < 0.1,
      });
    },
  };
}
