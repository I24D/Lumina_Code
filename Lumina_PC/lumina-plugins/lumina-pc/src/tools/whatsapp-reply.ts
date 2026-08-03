import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { bridgePost } from "../utils/windows-bridge.js";

export function createWhatsappReplyTool(): AnyAgentTool {
  return {
    name: "lumina_whatsapp_reply",
    description:
      "Replies to a WhatsApp conversation in one step: fuzzy-matches the contact in WhatsApp Desktop " +
      "(or the Phone Link mirror), opens the chat, types the message, submits with Enter, and verifies it was sent. " +
      "Use only for direct, low-risk replies the user asked for. Never use for groups, codes, payments, or sensitive content. " +
      "If unsure of the exact contact name, read the visible conversations first.",
    parameters: Type.Object({
      contact: Type.String({
        minLength: 1,
        description: "The conversation/contact name as shown in WhatsApp, e.g. 'Mamá' or 'Juan Pérez'.",
      }),
      message: Type.String({
        minLength: 1,
        maxLength: 2000,
        description: "The exact text to send.",
      }),
    }),
    async execute(_toolCallId: string, params) {
      const contact = params.contact?.trim();
      const message = params.message?.trim();
      if (!contact || !message) {
        return jsonResult({ ok: false, error: "contact and message are required" });
      }
      const response = await bridgePost(
        "/whatsapp/reply",
        { contact, message },
        60_000,
      );
      return jsonResult({
        ...response,
        ok: response.ok === true,
        via: "lumina-windows-bridge",
      });
    },
  };
}
