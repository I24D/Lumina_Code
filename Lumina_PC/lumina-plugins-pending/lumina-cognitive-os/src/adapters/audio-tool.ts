/**
 * audio-tool.ts — `lumina_audio`: system audio adapter (§5).
 *
 * Wraps `audio_manager.py` (pycaw). Deterministic volume/mute/device control
 * so "sube el volumen a 30%" is an API call, not a guessed slider drag.
 */
import { Type } from "typebox";

import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

export function createAudioTool(): AnyAgentTool {
  return {
    name: "lumina_audio",
    label: "Lumina Audio",
    description:
      "Controla el audio del sistema. Acciones: status (volumen 0..100 + mute + dispositivo), " +
      "set_volume {level 0..100}, mute {muted?} (toggle si se omite), list_devices. Requiere pycaw.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("status"),
          Type.Literal("set_volume"),
          Type.Literal("mute"),
          Type.Literal("list_devices"),
        ],
        { description: "Audio action." },
      ),
      level: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "set_volume target" })),
      muted: Type.Optional(Type.Boolean({ description: "mute target (omit to toggle)" })),
    }),
    async execute(_id, raw) {
      const { action, ...params } = raw as { action: string; [k: string]: unknown };
      const r = await runPythonSidecarJson<Record<string, unknown>>(
        "audio_manager",
        ["--action", action, "--json", JSON.stringify(params)],
        { timeoutMs: 10_000 },
      );
      if (!r.ok) return jsonResult({ ok: false, action, error: r.error });
      return jsonResult({ action, ...(r.data ?? {}) });
    },
  };
}
