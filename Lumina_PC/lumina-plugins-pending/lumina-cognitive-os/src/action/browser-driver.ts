/**
 * browser-driver.ts — Tool: lumina_browser_drive
 *
 * Thin wrapper over the Python Playwright sidecar. Persistent context lives
 * in `%APPDATA%/lumina-cognitive-os/browser-profile/<profile>` so cookies
 * survive between calls. Default profile is "default".
 *
 * The agent calls this AFTER lumina_risk_evaluate has returned WARNING or
 * better, and after lumina_director_route picked the Browser Agent.
 */
import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

const ACTIONS = ["goto", "click", "type", "screenshot", "read", "screencast_start", "screencast_stop"] as const;
type Action = (typeof ACTIONS)[number];

function profileDir(profile: string): string {
  const base =
    process.env.APPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".lumina-cognitive-os");
  return path.join(base, "lumina-cognitive-os", "browser-profile", profile);
}

export function createBrowserDriverTool(opts: { enabled: boolean }): AnyAgentTool {
  return {
    name: "lumina_browser_drive",
    label: "Lumina Browser Drive",
    description:
      "Drives a persistent Chromium profile via Playwright. Actions: goto, click, type, screenshot, read, screencast_start/stop. " +
      "Use this for any web task the user requests by voice: opening a URL, filling a form, scraping " +
      "innerText, taking a screenshot. Cookies persist across calls. " +
      "NEW (Playwright 1.59+): screencast_start/screencast_stop for programmatic video recording with action annotations.",
    parameters: Type.Object({
      action: Type.Union(
        ACTIONS.map((a) => Type.Literal(a)),
        { description: "Browser action." },
      ),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
      selector: Type.Optional(Type.String({ maxLength: 512 })),
      text: Type.Optional(Type.String({ maxLength: 4096 })),
      fullPage: Type.Optional(Type.Boolean()),
      headless: Type.Optional(Type.Boolean({ default: true })),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 500, maximum: 60_000, default: 5_000 })),
      waitUntil: Type.Optional(
        Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")]),
      ),
      outDir: Type.Optional(Type.String({ maxLength: 512, description: "Output directory for screencast videos." })),
      maxDurationMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 600_000, default: 300000, description: "Max screencast duration in ms (5 min default)." })),
      scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1, default: 0.5, description: "Screencast scale (0.1-1.0). 0.5 = 50% resolution for smaller files." })),
    }),
    async execute(_id, params) {
      if (!opts.enabled) {
        return jsonResult({
          ok: false,
          error:
            "browser driver is disabled. Set browserDriverEnabled=true in the lumina-cognitive-os plugin config.",
        });
      }
      const action = params.action as Action;
      if (action === "goto" && !params.url) {
        throw new ToolInputError("url is required for goto");
      }
      if ((action === "click" || action === "type") && !params.selector) {
        throw new ToolInputError("selector is required for click/type");
      }
      if (action === "type" && params.text === undefined) {
        throw new ToolInputError("text is required for type");
      }
      const profile = params.profile?.trim() || "default";
      const payload = {
        action,
        userDataDir: profileDir(profile),
        args: {
          url: params.url,
          selector: params.selector,
          text: params.text,
          fullPage: params.fullPage,
          headless: params.headless,
          timeoutMs: params.timeoutMs,
          waitUntil: params.waitUntil,
        },
      };
      const r = await runPythonSidecarJson<{ ok: boolean; [k: string]: unknown }>(
        "browser_drive",
        [],
        { timeoutMs: Math.max(15_000, (params.timeoutMs ?? 5_000) + 10_000), stdin: JSON.stringify(payload) },
      );
      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint:
            "If Playwright is missing run: pip install playwright && playwright install chromium",
        });
      }
      return jsonResult(r.data);
    },
  };
}
