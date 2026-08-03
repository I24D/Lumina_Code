import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { bridgePost } from "../utils/windows-bridge.js";

export function createNotificationDismissTool(): AnyAgentTool {
  return {
    name: "lumina_notification_dismiss",
    description:
      "Dismisses (removes) notifications from the Windows Notification Center. " +
      "Target one app with 'application', a specific card with 'match' (a word from its title/body), " +
      "or clear everything with all=true. Use after the user confirms they want a notification removed. " +
      "Reads back how many were dismissed and how many remain.",
    parameters: Type.Object({
      application: Type.Optional(
        Type.String({
          description: "Optional app/source filter, e.g. WhatsApp, Outlook, Teams.",
        }),
      ),
      match: Type.Optional(
        Type.String({
          description:
            "Optional substring of the notification title or body to target a single card (case/accent-insensitive).",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Clear every notification. Only used when neither application nor match is given.",
        }),
      ),
      maxDismiss: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Safety cap on how many cards to dismiss in one call. Defaults to 25.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const application = params.application?.trim();
      const match = params.match?.trim();
      const all = params.all === true;
      if (!application && !match && !all) {
        return jsonResult({
          ok: false,
          error: "specify application, match, or all=true to choose what to dismiss",
        });
      }
      const response = await bridgePost(
        "/notifications/dismiss",
        {
          ...(application ? { application } : {}),
          ...(match ? { match } : {}),
          ...(all ? { all: true } : {}),
          ...(params.maxDismiss !== undefined ? { maxDismiss: params.maxDismiss } : {}),
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
