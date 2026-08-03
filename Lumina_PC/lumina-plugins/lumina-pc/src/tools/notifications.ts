import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { bridgePost } from "../utils/windows-bridge.js";

export function createNotificationsTool(): AnyAgentTool {
  return {
    name: "lumina_notifications",
    description:
      "Reads notifications currently retained in the Windows Notification Center across applications. " +
      "Use when the user asks what notifications arrived, what Windows is showing, or for notifications from a specific app.",
    parameters: Type.Object({
      application: Type.Optional(
        Type.String({
          description: "Optional application/source filter, for example WhatsApp, Outlook, Claude, or OpenClaw.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum notifications to return. Defaults to 50.",
        }),
      ),
      includeHidden: Type.Optional(
        Type.Boolean({
          description: "Expand collapsed app groups before reading. Defaults to true.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const response = await bridgePost(
        "/notifications",
        {
          ...(params.application?.trim() ? { application: params.application.trim() } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.includeHidden !== undefined ? { includeHidden: params.includeHidden } : {}),
        },
        45_000,
      );
      return jsonResult({
        ...response,
        ok: response.ok === true,
        via: "lumina-windows-bridge",
      });
    },
  };
}
