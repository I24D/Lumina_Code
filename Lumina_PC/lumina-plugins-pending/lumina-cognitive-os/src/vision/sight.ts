/**
 * sight.ts — Tool: lumina_sight
 *
 * What Lumina is seeing RIGHT NOW. The continuous perception sidecar (running in
 * the interactive Windows session) keeps a fresh semantic snapshot of the
 * foreground app + its actionable UI elements; the windows-bridge exposes it at
 * GET /perception. This tool returns that snapshot so the agent acts on CURRENT
 * sight in one step — no screenshot capture/analyze round-trip.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";

export function createSightTool(bridgeUrl: string): AnyAgentTool {
  return {
    name: "lumina_sight",
    label: "Lumina Sight — current screen",
    description:
      "Lumina's live sight: the foreground app + its actionable UI elements (name, controlType, " +
      "automationId, click-center coords) kept fresh by continuous perception. Call this FIRST to " +
      "know what is on screen before acting — no screenshot needed. If richUia is false the " +
      "foreground is a web/Chromium app with few UIA elements; use lumina_screen_capture / " +
      "lumina_vision_parse for those. Act via lumina_ui_invoke (by name/automationId) or " +
      "lumina_smart_click (by the element's center coords).",
    parameters: Type.Object({}),
    async execute() {
      const base = (bridgeUrl || "http://127.0.0.1:8765").replace(/\/+$/u, "");
      try {
        const resp = await fetch(`${base}/perception`, { signal: AbortSignal.timeout(6_000) });
        const data = (await resp.json()) as Record<string, unknown>;
        return jsonResult(data);
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          hint: "Is the windows-bridge up and perception running? (dev:all launches both.)",
        });
      }
    },
  };
}
