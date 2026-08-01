import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

// Dedicated, single-purpose tool for the WhatsApp DESKTOP app (whatsapp.exe),
// kept separate from Phone Link / Enlace móvil (see lumina_phone_link) so the
// agent never has to guess which channel a message lives on. Actions map 1:1 to
// the deterministic /whatsapp/* Windows Bridge endpoints backed by whatsapp.py.
const DESCRIPTION = [
  "Control the WhatsApp DESKTOP app (the native whatsapp.exe on this PC) to read and send WhatsApp messages.",
  "This is ONLY for WhatsApp. For SMS/phone messages mirrored from the phone via Windows Phone Link (Enlace móvil), use lumina_phone_link instead.",
  "Deterministic flow to reply to a contact: 1) action:\"find_contact\" { query } to resolve the exact chat name; 2) action:\"read\" { contact } to read recent messages if you need context; 3) action:\"reply\" { contact, message } to send. Set dryRun:true on reply to resolve+validate without sending.",
  "It uses semantic UI Automation (never blind screen coordinates); a send is only reported successful after the outgoing bubble is verified in the UI.",
  "Do not use the generic lumina_windows_bridge UI tools (/ui_inspect, /ui_interact, /vision_click) for WhatsApp — this tool is the fast, reliable path.",
].join(" ");

export const luminaWhatsAppTool: Tool = {
  type: "function",
  displayTitle: "WhatsApp (Desktop)",
  wouldLikeTo: "use WhatsApp Desktop",
  isCurrently: "using WhatsApp Desktop",
  hasAlready: "used WhatsApp Desktop",
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.LuminaWhatsApp,
    description: DESCRIPTION,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "find_contact",
            "read",
            "reply",
            "list_statuses",
            "publish_status",
          ],
          description:
            "find_contact: resolve/list chats (uses WhatsApp's own search). read: recent messages of a contact. reply: send text or an attachment caption to a contact. list_statuses: view status list without opening. publish_status: publish a status (needs confirmation).",
        },
        contact: {
          type: "string",
          description:
            "Target chat/contact name. Required for read and reply. Partial names are fuzzy-resolved to the exact chat.",
        },
        message: {
          type: "string",
          description:
            "For reply: the text to send (or a caption when mediaPath is set).",
        },
        mediaPath: {
          type: "string",
          description:
            "For reply/publish_status: absolute local path to an image/video/audio/document to attach.",
        },
        query: {
          type: "string",
          description: "For find_contact: search term for the chat name.",
        },
        limit: {
          type: "number",
          description:
            "For read/find_contact/list_statuses: max items to return.",
        },
        unreadOnly: {
          type: "boolean",
          description: "For find_contact: only chats with unread messages.",
        },
        includePreviews: {
          type: "boolean",
          description: "For find_contact: include last-message previews.",
        },
        caption: {
          type: "string",
          description: "For publish_status: caption when publishing media.",
        },
        background: {
          type: "string",
          description:
            "For publish_status: background style for a text-only status.",
        },
        dryRun: {
          type: "boolean",
          description:
            "For reply/publish_status: resolve the contact and validate content WITHOUT sending. Use it to preview before a real send.",
        },
        bridgeUrl: {
          type: "string",
          description:
            "Optional override for the local Bridge URL. Defaults to LUMINA_BRIDGE_URL or http://127.0.0.1:8765.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    const action =
      typeof parsedArgs.action === "string" ? parsedArgs.action.trim() : "";
    const isRealSend =
      (action === "reply" || action === "publish_status") &&
      parsedArgs.dryRun !== true;
    if (isRealSend && basePolicy === "allowedWithoutPermission") {
      return "allowedWithPermission";
    }
    return basePolicy;
  },
  systemMessageDescription: {
    prefix: `To read or send WhatsApp Desktop messages, call the ${BuiltInToolNames.LuminaWhatsApp} tool. It is ONLY for the WhatsApp app; for phone SMS via Enlace móvil use lumina_phone_link. For example, to reply to a contact:`,
    exampleArgs: [
      ["action", "reply"],
      ["contact", "Sandra"],
      ["message", "Voy en camino"],
    ],
  },
  toolCallIcon: "ChatBubbleLeftRightIcon",
};
