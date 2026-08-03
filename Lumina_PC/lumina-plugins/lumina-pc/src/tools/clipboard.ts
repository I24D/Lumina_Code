/**
 * clipboard.ts
 * Tool: lumina_clipboard
 *
 * Read from or write to the Windows clipboard via PowerShell.
 * Allows I24D to see what the user copied and to paste content programmatically.
 */

import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { canRunPowerShell, psEscape, runPowerShell } from "../utils/powershell.js";
import { bridgePost, isWindowsBridgeMode } from "../utils/windows-bridge.js";

export function createClipboardTool(): AnyAgentTool {
  return {
    name: "lumina_clipboard",
    description:
      "Gets or sets the Windows clipboard text content. " +
      "Use get to read what the user has copied. Use set to place text into the clipboard so the user or another app can paste it.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set")], {
        description: "get — read clipboard content. set — write text to clipboard.",
      }),
      text: Type.Optional(
        Type.String({
          description: "Text to write to the clipboard (required for set action).",
        }),
      ),
    }),
    ownerOnly: true,
    async execute(_toolCallId: string, params) {
      if (isWindowsBridgeMode()) {
        if (params.action === "set" && params.text === undefined) {
          throw new ToolInputError("text is required for set action.");
        }
        const response = await bridgePost("/clipboard", {
          action: params.action,
          ...(params.text === undefined ? {} : { text: params.text }),
        });
        return jsonResult({
          ok: response.ok === true,
          text: response.text ?? "",
          via: "lumina-windows-bridge",
          error: response.ok === true ? undefined : response.error,
        });
      }

      if (!canRunPowerShell()) {
        return jsonResult({
          ok: false,
          error: "Clipboard access needs Windows or WSL (powershell.exe over interop).",
        });
      }

      if (params.action === "get") {
        const result = await runPowerShell("Get-Clipboard", 5_000);
        return jsonResult({
          ok: result.ok,
          text: result.stdout,
          error: result.ok ? undefined : result.error,
        });
      }

      if (params.action === "set") {
        const text = params.text;
        if (text === undefined) throw new ToolInputError("text is required for set action.");
        const result = await runPowerShell(`Set-Clipboard -Value "${psEscape(text)}"`, 5_000);
        return jsonResult({
          ok: result.ok,
          text,
          error: result.ok ? undefined : result.error,
        });
      }

      throw new ToolInputError("action must be get or set.");
    },
  };
}
