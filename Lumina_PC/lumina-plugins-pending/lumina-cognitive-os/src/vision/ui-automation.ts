/**
 * ui-automation.ts — Tool: lumina_vision_ui_tree
 *
 * Returns the UI Automation tree of the foreground window (or a given PID).
 * Backed by the Python sidecar `uia_tree.py` which uses the `uiautomation`
 * package. Lumina uses this to know WHAT is clickable, not just what is
 * visible — OCR cannot tell you "the Submit button at (x,y) is disabled".
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

export function createUiTreeTool(): AnyAgentTool {
  return {
    name: "lumina_vision_ui_tree",
    label: "Lumina Vision — UI Tree",
    description:
      "Returns the Windows UI Automation tree of the foreground window. Each node has name, " +
      "automationId, controlType, className, bbox, enabled, offscreen, optional value. Use this " +
      "when the user asks 'qué hay en pantalla', 'haz click en el botón Guardar', or before " +
      "automating any GUI action so you know the element exists and is enabled.",
    parameters: Type.Object({
      pid: Type.Optional(
        Type.Number({ description: "Optional process ID whose top window to walk. Defaults to foreground." }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ minimum: 1, maximum: 12, default: 6 }),
      ),
      maxNodes: Type.Optional(
        Type.Number({ minimum: 10, maximum: 2000, default: 400 }),
      ),
    }),
    async execute(_id, params) {
      const args: string[] = [];
      if (typeof params.pid === "number") args.push("--pid", String(params.pid));
      if (typeof params.maxDepth === "number") args.push("--max-depth", String(params.maxDepth));
      if (typeof params.maxNodes === "number") args.push("--max-nodes", String(params.maxNodes));
      const r = await runPythonSidecarJson<{ ok: boolean; [k: string]: unknown }>(
        "uia_tree",
        args,
        { timeoutMs: 20_000 },
      );
      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint:
            "Make sure Python is on PATH and run: pip install uiautomation. " +
            "Alternative: rely on lumina_screen_capture + OCR for read-only context.",
        });
      }
      return jsonResult(r.data);
    },
  };
}
