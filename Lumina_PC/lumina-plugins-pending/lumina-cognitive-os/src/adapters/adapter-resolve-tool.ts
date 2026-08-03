/**
 * adapter-resolve-tool.ts — `lumina_adapter_resolve`: which adapter for an app?
 *
 * Surfaces the App Adapter Registry (§4/§5) to the agent so it can ask, before
 * acting, "what's the best way to control <app>?" — e.g. Office → COM, browser
 * → CDP, everything else → UIA. Pass a processName, or omit to list all.
 */
import { Type } from "typebox";

import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { listAdapters, resolveAdapter } from "./adapter-registry.js";

export function createAdapterResolveTool(): AnyAgentTool {
  return {
    name: "lumina_adapter_resolve",
    label: "Lumina Adapter Resolve",
    description:
      "Devuelve el adaptador especializado recomendado para una app (Office→COM, navegador/Electron→CDP, " +
      "Explorer→Shell, VS Code→CLI, terminal→invocación directa; resto→UIA genérico). Pasa processName " +
      "(ej. winword.exe) para resolver uno, u omítelo para listar todos. Úsalo antes de actuar para elegir " +
      "la vía estructural antes que clicar la UI.",
    parameters: Type.Object({
      processName: Type.Optional(Type.String({ description: "ej. winword.exe, chrome.exe, explorer.exe" })),
    }),
    async execute(_id, raw) {
      const params = raw as { processName?: string };
      if (params.processName) {
        return jsonResult({ ok: true, adapter: resolveAdapter(params.processName) });
      }
      return jsonResult({ ok: true, adapters: listAdapters() });
    },
  };
}
