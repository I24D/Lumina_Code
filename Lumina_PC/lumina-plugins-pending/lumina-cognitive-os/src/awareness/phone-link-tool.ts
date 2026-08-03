import { Type } from "typebox";
import type { BridgeClient } from "../shared/bridge-client.js";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";

type PhoneLinkResponse = {
  ok?: boolean;
  running?: boolean;
  connected?: boolean;
  notificationFeedReady?: boolean;
  error?: string;
  [key: string]: unknown;
};

export function createPhoneLinkStatusTool(bridge: BridgeClient): AnyAgentTool {
  return {
    name: "lumina_phone_link_status",
    label: "Lumina Phone Link Status",
    description:
      "Reads the Windows Phone Link connection and mobile-notification feed status. " +
      "Use this before relying on mirrored Android notifications or replies.",
    parameters: Type.Object({}),
    async execute() {
      const result = await bridge.get<PhoneLinkResponse>("/phone_link/status", 8_000);
      return jsonResult(
        result ?? {
          ok: false,
          error: "phone_link_status_unavailable",
          hint: "Verify that Phone Link and Lumina Windows Bridge are running.",
        },
      );
    },
  };
}

export function createWhatsappRespondTool(bridge: BridgeClient): AnyAgentTool {
  return {
    name: "lumina_whatsapp_respond",
    label: "Lumina WhatsApp Respond",
    description:
      "Fastest, one-call way to answer a WhatsApp message: pass just the contact name and the " +
      "reply text and it fuzzy-finds the chat, types, and sends in a single step. Prefer this over " +
      "lumina_phone_link_reply when replying to a WhatsApp notification — it does not need the exact " +
      "notification metadata, so it is the first tool to reach for to respond to notifications quickly. " +
      "Only for one-to-one WhatsApp chats; do not use it for groups, sensitive content, or anything " +
      "needing user confirmation. Pass dryRun=true to locate and stage the reply without sending.",
    parameters: Type.Object({
      contact: Type.String({
        description: "Contact/chat name as shown in WhatsApp. Fuzzy-matched.",
        minLength: 1,
      }),
      message: Type.String({ maxLength: 1000 }),
      window: Type.Optional(
        Type.Union([Type.Literal("whatsapp"), Type.Literal("phone_link")], {
          description: "Target surface. Defaults to auto (WhatsApp Desktop first, then Phone Link).",
        }),
      ),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const contact = params.contact.trim();
      const message = params.message.trim();
      if (!contact || !message) {
        return jsonResult({
          ok: false,
          error: "contact_and_message_required",
          sent: false,
        });
      }
      const result = await bridge.post<PhoneLinkResponse>(
        "/whatsapp/reply",
        {
          contact,
          message,
          window: params.window ?? undefined,
          dryRun: params.dryRun === true,
        },
        30_000,
      );
      return jsonResult(
        result ?? {
          ok: false,
          error: "whatsapp_reply_unavailable",
          sent: false,
          hint: "Verify that WhatsApp (or Phone Link) and Lumina Windows Bridge are running.",
        },
      );
    },
  };
}

export function createPhoneLinkReplyTool(bridge: BridgeClient): AnyAgentTool {
  return {
    name: "lumina_phone_link_reply",
    label: "Lumina Phone Link Reply",
    description:
      "Replies to one exact direct mobile-message notification through Windows Phone Link. " +
      "WhatsApp groups, ambiguous notifications, sensitive content, and context mismatches are " +
      "blocked by the Windows Bridge. For normal chat use, require explicit user confirmation " +
      "and pass confirmed=true. Start Talk has a separate restricted standing policy for its own " +
      "verified notification events.",
    parameters: Type.Object({
      notificationId: Type.String(),
      appUserModelId: Type.String(),
      mobileApp: Type.String(),
      sender: Type.String(),
      message: Type.String(),
      textElements: Type.Array(Type.String()),
      conversationKind: Type.Literal("direct"),
      replyEligibility: Type.Literal("eligible"),
      replyText: Type.String({ maxLength: 280 }),
      confirmed: Type.Boolean({
        description: "True only after the user explicitly confirms this exact reply.",
      }),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      if (!params.confirmed && !params.dryRun) {
        return jsonResult({
          ok: false,
          refused: "needs_confirmation",
          sent: false,
          hint: "Show the exact recipient and reply text, ask the user to confirm, then call again with confirmed=true.",
        });
      }
      const result = await bridge.post<PhoneLinkResponse>(
        "/phone_link/reply",
        {
          notificationId: params.notificationId,
          appUserModelId: params.appUserModelId,
          mobileApp: params.mobileApp,
          sender: params.sender,
          message: params.message,
          textElements: params.textElements,
          conversationKind: params.conversationKind,
          replyEligibility: params.replyEligibility,
          replyText: params.replyText,
          dryRun: params.dryRun === true,
        },
        30_000,
      );
      return jsonResult(
        result ?? {
          ok: false,
          error: "phone_link_reply_unavailable",
          sent: false,
        },
      );
    },
  };
}
