/**
 * browser-screencast.ts — Tool: lumina_browser_screencast
 *
 * High-level wrapper for Playwright 1.59+ Screencast API.
 * Provides simple start/stop/status actions for recording browser automation sessions.
 * Useful for debugging PC Operator loops and generating proof of execution.
 *
 * Videos are saved to: c:/I24D_WhatsApp/screencasts/<sessionId>/<timestamp>.webm
 */
import path from "node:path";
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

function screencastsDir(): string {
  return "c:/I24D_WhatsApp/screencasts";
}

export function createBrowserScreencastTool(): AnyAgentTool {
  return {
    name: "lumina_browser_screencast",
    label: "Lumina Browser Screencast",
    description:
      "Controls Playwright 1.59+ Screencast API for programmatic video recording of browser sessions. " +
      "Actions: start (begin recording), stop (end recording), status (check if recording). " +
      "Videos saved to c:/I24D_WhatsApp/screencasts/. Useful for debugging and audit trails.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")],
        { description: "Screencast action." },
      ),
      sessionId: Type.Optional(Type.String({ maxLength: 64, description: "Session identifier for organizing recordings." })),
      maxDurationMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 600_000, default: 300000 })),
      scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1, default: 0.5 })),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
    }),
    async execute(_id, params) {
      const action = params.action as "start" | "stop" | "status";
      const profile = params.profile?.trim() || "default";
      const baseDir = path.join(
        process.env.APPDATA ?? "C:\\Users\\dal_n\\AppData\\Roaming",
        "lumina-cognitive-os",
        "browser-profile",
        profile,
      );

      if (action === "status") {
        const stateFile = path.join(baseDir, ".screencast_state.json");
        const fs = await import("node:fs/promises");
        try {
          const content = await fs.readFile(stateFile, "utf-8");
          const state = JSON.parse(content);
          return jsonResult({
            ok: true,
            active: state.active ?? false,
            videoPath: state.videoPath,
            startedAt: state.startedAt,
            maxDurationMs: state.maxDurationMs,
            scale: state.scale,
          });
        } catch {
          return jsonResult({ ok: true, active: false });
        }
      }

      const sidecarAction = action === "start" ? "screencast_start" : "screencast_stop";
      const payload = {
        action: sidecarAction,
        userDataDir: baseDir,
        args: {
          outDir: params.sessionId ? path.join(screencastsDir(), params.sessionId) : screencastsDir(),
          maxDurationMs: params.maxDurationMs,
          scale: params.scale,
        },
      };

      const r = await runPythonSidecarJson<{ ok: boolean; [k: string]: unknown }>(
        "browser_drive",
        [],
        { timeoutMs: 15_000, stdin: JSON.stringify(payload) },
      );

      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint: "Ensure Playwright 1.59+ is installed: pip install --upgrade playwright",
        });
      }

      return jsonResult(r.data);
    },
  };
}
