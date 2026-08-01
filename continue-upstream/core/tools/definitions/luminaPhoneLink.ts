import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

// Dedicated, single-purpose tool for Windows Phone Link ("Enlace móvil"): the
// SMS / phone messages mirrored from the paired phone (Google Messages, SMS,
// WhatsApp-via-phone, Telegram, etc.) surfaced as Windows notification cards.
// This is intentionally separate from the WhatsApp DESKTOP app (lumina_whatsapp)
// so the agent never guesses which channel a message lives on, and never has to
// improvise with blind UI automation. The reply is guarded: the bridge only
// sends into a card whose sender matches the one being answered.
const DESCRIPTION = [
  "Read and reply to phone messages mirrored on this PC through Windows Phone Link / Enlace móvil (SMS, Google Messages, Telegram, WhatsApp-from-phone, etc.).",
  "This is for the PHONE's messages, NOT the WhatsApp desktop app — for WhatsApp Desktop use lumina_whatsapp.",
  'Deterministic flow: 1) action:"read" to list pending phone-message cards (each with sender, message, mobileApp, and whether it can be replied to); 2) action:"reply" { sender, replyText } — the tool finds that sender\'s card and sends the reply inline. Add message to disambiguate if the same sender has several cards, or dryRun:true to validate without sending.',
  "Only direct (1:1) messages are repliable; group and sensitive (codes/banking) cards are blocked by design. If a reply is not eligible, read first and tell the user why.",
  "Do NOT use lumina_windows_bridge UI tools for this — this tool is the fast, safe path for Enlace móvil.",
].join(" ");

export const luminaPhoneLinkTool: Tool = {
  type: "function",
  displayTitle: "Enlace móvil (Phone Link)",
  wouldLikeTo: "use Phone Link (Enlace móvil)",
  isCurrently: "using Phone Link (Enlace móvil)",
  hasAlready: "used Phone Link (Enlace móvil)",
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.LuminaPhoneLink,
    description: DESCRIPTION,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["read", "reply"],
          description:
            "read: list current phone-message cards (sender, message, app, reply eligibility). reply: send replyText to the card that matches sender.",
        },
        sender: {
          type: "string",
          description:
            "For reply: the contact/sender name exactly as shown on the card.",
        },
        replyText: {
          type: "string",
          description: "For reply: the text to send back.",
        },
        message: {
          type: "string",
          description:
            "Optional for reply: original message text to disambiguate when the same sender has multiple cards.",
        },
        limit: {
          type: "number",
          description: "For read: max cards to return.",
        },
        dryRun: {
          type: "boolean",
          description:
            "For reply: resolve and validate the target card WITHOUT sending.",
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
    if (
      action === "reply" &&
      parsedArgs.dryRun !== true &&
      basePolicy === "allowedWithoutPermission"
    ) {
      return "allowedWithPermission";
    }
    return basePolicy;
  },
  systemMessageDescription: {
    prefix: `To read or reply to the phone's messages mirrored via Enlace móvil / Phone Link, call the ${BuiltInToolNames.LuminaPhoneLink} tool. This is NOT the WhatsApp desktop app (use lumina_whatsapp for that). For example, to reply to a sender:`,
    exampleArgs: [
      ["action", "reply"],
      ["sender", "Mamá"],
      ["replyText", "Ya voy en camino"],
    ],
  },
  toolCallIcon: "DevicePhoneMobileIcon",
};
