/**
 * ui-invoke.ts — Tool: lumina_ui_invoke
 *
 * Acts on a Windows UI element BY IDENTITY (automationId or name) using native
 * UI Automation patterns (Invoke / SetValue / Toggle / SelectionItem / Focus),
 * backed by `uia_tree.py --invoke`. This is more reliable than clicking a
 * coordinate (lumina_smart_click) because a UIA pattern acts on the element
 * directly — it works even when the element is scrolled off-screen or its
 * window is not in the foreground. Prefer this once you know the target's
 * automationId/name (e.g. from lumina_vision_ui_tree / lumina_vision_ui_resolve).
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

export function createUiInvokeTool(): AnyAgentTool {
  return {
    name: "lumina_ui_invoke",
    label: "Lumina Vision — UI Invoke",
    description:
      "Act on a Windows UI element by identity (automationId preferred, or name) via native UIA " +
      "patterns instead of a coordinate click. Works even if the element is off-screen or its " +
      "window is not foreground. action: invoke (default, i.e. press/click) | set_value (needs value) | " +
      "toggle | select | focus. Example — save in Word: {name:'Guardar', action:'invoke'}. " +
      "Resolve the target first with lumina_vision_ui_tree/lumina_vision_ui_resolve when unsure of the name.",
    parameters: Type.Object({
      automationId: Type.Optional(
        Type.String({ description: "Preferred: exact AutomationId of the target element." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Match target by visible Name when no automationId is known." }),
      ),
      controlType: Type.Optional(
        Type.String({ description: "Optional ControlType filter (Button, Edit, MenuItem, ...)." }),
      ),
      action: Type.Optional(
        Type.String({ default: "invoke", description: "invoke | click | set_value | toggle | select | focus" }),
      ),
      value: Type.Optional(
        Type.String({ description: "Text to write when action is set_value." }),
      ),
      nameMatch: Type.Optional(
        Type.String({ default: "contains", description: "contains | exact (how name is matched)" }),
      ),
      pid: Type.Optional(
        Type.Number({ description: "Target window process ID. Defaults to the foreground window." }),
      ),
    }),
    async execute(_id, params) {
      if (!params.automationId && !params.name) {
        return jsonResult({ ok: false, error: "provide automationId or name" });
      }
      const args: string[] = ["--invoke"];
      if (params.automationId) args.push("--automation-id", String(params.automationId));
      if (params.name) args.push("--name", String(params.name));
      if (params.controlType) args.push("--control-type", String(params.controlType));
      if (params.action) args.push("--action", String(params.action));
      if (typeof params.value === "string") args.push("--value", params.value);
      if (params.nameMatch) args.push("--name-match", String(params.nameMatch));
      if (typeof params.pid === "number") args.push("--pid", String(params.pid));
      const r = await runPythonSidecarJson<{ ok: boolean; [k: string]: unknown }>(
        "uia_tree",
        args,
        { timeoutMs: 20_000 },
      );
      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint: "Ensure the target window is open. Resolve the element with lumina_vision_ui_tree first.",
        });
      }
      return jsonResult(r.data);
    },
  };
}
