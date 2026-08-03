/**
 * registry-tool.ts — `lumina_registry`: Windows Registry adapter (§5).
 *
 * Wraps `registry_manager.py`. Reads are free; writes/deletes require
 * confirm=true and are blocked on boot/security/policy hives by the sidecar's
 * denylist. Use for app settings (themes, per-app prefs), not system surgery.
 */
import { Type } from "typebox";

import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

export function createRegistryTool(): AnyAgentTool {
  return {
    name: "lumina_registry",
    label: "Lumina Registry",
    description:
      "Lee/escribe el Registro de Windows de forma segura. Acciones: get {hive,path,name?}, " +
      "list {hive,path}, set {hive,path,name,value,type?,confirm}, delete {hive,path,name,confirm}. " +
      "Las lecturas son libres; escrituras/borrados exigen confirm=true y están bloqueados en hives " +
      "críticas (boot/seguridad/políticas/Run). hive ∈ HKCU|HKLM|HKCR|HKU|HKCC. type ∈ sz|dword|expand_sz|multi_sz.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("get"), Type.Literal("list"), Type.Literal("set"), Type.Literal("delete")],
        { description: "Registry operation." },
      ),
      hive: Type.Optional(Type.String({ description: "HKCU (default) | HKLM | HKCR | HKU | HKCC" })),
      path: Type.String({ description: "Key path, e.g. Software\\MyApp" }),
      name: Type.Optional(Type.String({ description: "Value name (omit on get to read all)" })),
      value: Type.Optional(Type.Unknown({ description: "Value to write (set)" })),
      type: Type.Optional(Type.String({ description: "sz | dword | expand_sz | multi_sz" })),
      confirm: Type.Optional(Type.Boolean({ description: "Required true for set/delete" })),
    }),
    async execute(_id, raw) {
      const { action, ...params } = raw as { action: string; [k: string]: unknown };
      const r = await runPythonSidecarJson<Record<string, unknown>>(
        "registry_manager",
        ["--action", action, "--json", JSON.stringify(params)],
        { timeoutMs: 12_000 },
      );
      if (!r.ok) return jsonResult({ ok: false, action, error: r.error });
      return jsonResult({ action, ...(r.data ?? {}) });
    },
  };
}
