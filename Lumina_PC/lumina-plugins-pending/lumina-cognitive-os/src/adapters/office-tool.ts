/**
 * office-tool.ts — `lumina_office`: drive Office via the COM adapter (§5).
 *
 * Thin wrapper over the `office_com.py` sidecar. Structural document access
 * (read text, insert, save, read/write Excel cells, Outlook unread) — the
 * App Adapter Registry's preferred path for Office before generic UIA.
 */
import { Type } from "typebox";

import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

export function createOfficeTool(): AnyAgentTool {
  return {
    name: "lumina_office",
    label: "Lumina Office (COM)",
    description:
      "Controla Microsoft Office por COM (sin depender del foco de ventana). Acciones: status (qué apps " +
      "de Office corren), word_get_text, word_insert_text {text}, word_save, excel_get_cell {cell,sheet?}, " +
      "excel_set_cell {cell,value,sheet?}, outlook_unread. Requiere pywin32. Adjunta a la instancia YA " +
      "abierta; no lanza Office.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("status"),
          Type.Literal("word_get_text"),
          Type.Literal("word_insert_text"),
          Type.Literal("word_save"),
          Type.Literal("excel_get_cell"),
          Type.Literal("excel_set_cell"),
          Type.Literal("outlook_unread"),
        ],
        { description: "Office COM action to run." },
      ),
      text: Type.Optional(Type.String({ description: "word_insert_text" })),
      cell: Type.Optional(Type.String({ description: 'excel cell, e.g. "B2"' })),
      sheet: Type.Optional(Type.String({ description: "excel sheet name (optional)" })),
      value: Type.Optional(Type.Unknown({ description: "excel_set_cell value" })),
    }),
    async execute(_id, raw) {
      const { action, ...params } = raw as { action: string; [k: string]: unknown };
      const r = await runPythonSidecarJson<Record<string, unknown>>(
        "office_com",
        ["--action", action, "--json", JSON.stringify(params)],
        { timeoutMs: 20_000 },
      );
      if (!r.ok) return jsonResult({ ok: false, action, error: r.error });
      return jsonResult({ action, ...(r.data ?? {}) });
    },
  };
}
