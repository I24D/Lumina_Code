/**
 * window-classify-tool.ts — Exposes the §3 window classifier to the agent.
 *
 * `lumina_window_classify` tells Lumina HOW to approach a window before she
 * touches it: what kind it is (Win32/WPF/UWP/Chromium-Electron) and the
 * ordered engine preference (adapter → UIA → CDP → … → OmniParser → mouse).
 * With no args it classifies the current foreground window via the Bridge;
 * pass processName/className to classify a hypothetical target.
 */
import { Type } from "typebox";

import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import {
  classifyForegroundWindow,
  classifyWindow,
  strategyOrder,
} from "./window-classify.js";

export function createWindowClassifyTool(bridgeUrl: string): AnyAgentTool {
  return {
    name: "lumina_window_classify",
    label: "Lumina Window Classify",
    description:
      "Clasifica una ventana (Win32/WPF/UWP/Chromium-Electron) y devuelve el orden de estrategia " +
      "recomendado (§3): adaptador → UIA → CDP → … → OmniParser → mouse → OCR. Sin argumentos clasifica " +
      "la ventana en foreground (vía Bridge). Pasa processName/className para clasificar un objetivo " +
      "hipotético. Úsalo para decidir SI el DOM (navegador) es la fuente de verdad o si conviene UIA nativo.",
    parameters: Type.Object({
      processName: Type.Optional(Type.String({ description: "ej. chrome.exe, code.exe, explorer.exe" })),
      className: Type.Optional(Type.String({ description: "Win32 class, ej. Chrome_WidgetWin_1" })),
      elevated: Type.Optional(Type.Boolean({ description: "La ventana corre elevada (integridad alta)." })),
    }),
    async execute(_id, raw) {
      const params = raw as { processName?: string; className?: string; elevated?: boolean };
      if (params.processName || params.className || params.elevated !== undefined) {
        const classification = classifyWindow({
          processName: params.processName,
          className: params.className,
          elevated: params.elevated,
        });
        return jsonResult({
          ok: true,
          classification,
          strategyOrder: strategyOrder(classification),
        });
      }
      const fg = await classifyForegroundWindow(bridgeUrl);
      const { foreground, ...classification } = fg;
      return jsonResult({
        ok: true,
        foreground,
        classification,
        strategyOrder: strategyOrder(classification),
      });
    },
  };
}
