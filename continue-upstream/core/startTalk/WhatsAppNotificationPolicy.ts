import { enrichPhoneLinkNotification } from "./PhoneLinkNotificationPolicy.js";
import type { StartTalkNotification } from "./types.js";

// Classifies an incoming Windows notification as a WhatsApp message for which
// the trusted-contact monitor may suggest a draft. Two origins are supported:
//   - "whatsapp_desktop": the native WhatsApp app on this PC.
//   - "phone_link":       WhatsApp mirrored from the phone via Enlace móvil.
// Only DIRECT (1:1) chats are ever eligible. Groups, aggregated toasts and
// anything that looks sensitive (codes, money, passwords) are refused by design.

export type WhatsAppSource = "whatsapp_desktop" | "phone_link";

export type WhatsAppReplyReason =
  | "eligible"
  | "group_blocked"
  | "sensitive_blocked"
  | "ambiguous"
  | "empty";

export interface WhatsAppReplyCandidate {
  source: WhatsAppSource;
  /** Contact/sender name (the WhatsApp chat title for a direct chat). */
  sender: string;
  /** The incoming message text. */
  message: string;
  /** True only when this is a direct chat safe to auto-answer. */
  eligible: boolean;
  reason: WhatsAppReplyReason;
  /** Enriched notification, needed to build the Phone Link reply payload. */
  notification: StartTalkNotification;
}

// A leading "Name: message" body is the reliable signal that a WhatsApp Desktop
// toast belongs to a GROUP chat (direct chats put the message alone in the body).
// Kept conservative (name-looking prefix, few words) so a direct message that
// merely contains a colon is not misread — and if it is, refusing is the safe way
// to fail.
const GROUP_BODY_PATTERN = /^[\p{L}][\p{L}\p{M}\s.'’-]{0,30}:\s+\S/u;
const GROUP_TITLE_PATTERN = /\b(group|grupo|community|comunidad)\b/iu;
// Common non-name words that can legitimately open a DIRECT message with a colon
// ("Recordatorio: …", "Nota: …"). When the colon prefix starts with one of these
// it is NOT the "Sender:" of a group toast, so the message stays answerable.
const NON_NAME_COLON_LEAD = new Set([
  "recordatorio",
  "nota",
  "aviso",
  "ojo",
  "urgente",
  "importante",
  "pd",
  "posdata",
  "info",
  "informacion",
  "atencion",
  "hola",
  "ok",
  "re",
  "fwd",
  "reenviado",
  "tip",
  "dato",
  "oferta",
  "promo",
  "nuevo",
  "update",
  "actualizacion",
  "alerta",
]);
const AGGREGATE_PATTERN =
  /\b(\d+\s+(messages?|mensajes?|chats?|new)|new messages|mensajes nuevos|nuevos mensajes)\b/iu;
const SENSITIVE_PATTERN =
  /\b(otp|one[- ]time|passcode|password|contrasena|contraseña|verification code|codigo de verificacion|código de verificación|security code|codigo de seguridad|código de seguridad|bank|banco|credit card|tarjeta de credito|tarjeta de crédito|wire transfer|transferencia|social security|ssn|money|dinero|payment|pago|pagar|venmo|cash ?app|zelle)\b/iu;

function normalize(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** True when the toast comes from the native WhatsApp Desktop app. */
function isWhatsAppDesktop(notification: StartTalkNotification): boolean {
  const appId = normalize(notification.appUserModelId);
  const appName = normalize(notification.appName);
  // Phone Link mirrors WhatsApp too, but through microsoft.yourphone_*; treat
  // those as phone_link, not desktop.
  if (appId.startsWith("microsoft.yourphone_")) {
    return false;
  }
  return appName.includes("whatsapp") || appId.includes("whatsapp");
}

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function classifyDesktop(
  notification: StartTalkNotification,
): WhatsAppReplyCandidate {
  const sender = (notification.title ?? "").trim();
  const message = (notification.body ?? "").trim();
  const base: Omit<WhatsAppReplyCandidate, "eligible" | "reason"> = {
    source: "whatsapp_desktop",
    sender,
    message,
    notification: { ...notification, sourceKind: "windows" },
  };

  if (!sender || !message) {
    return { ...base, eligible: false, reason: "empty" };
  }
  if (AGGREGATE_PATTERN.test(`${sender} ${message}`)) {
    // "3 mensajes nuevos" style summaries carry no single answerable message.
    return { ...base, eligible: false, reason: "ambiguous" };
  }
  const colonPrefix = message.split(":")[0] ?? "";
  const firstPrefixToken = normalize(colonPrefix).split(" ")[0] ?? "";
  const looksGroup =
    GROUP_TITLE_PATTERN.test(sender) ||
    (GROUP_BODY_PATTERN.test(message) &&
      countWords(colonPrefix) <= 3 &&
      !NON_NAME_COLON_LEAD.has(firstPrefixToken));
  if (looksGroup) {
    return { ...base, eligible: false, reason: "group_blocked" };
  }
  if (SENSITIVE_PATTERN.test(`${sender} ${message}`)) {
    return { ...base, eligible: false, reason: "sensitive_blocked" };
  }
  return { ...base, eligible: true, reason: "eligible" };
}

function classifyPhoneLink(
  notification: StartTalkNotification,
): WhatsAppReplyCandidate | null {
  const enriched = enrichPhoneLinkNotification(notification);
  // Only WhatsApp routed through Phone Link — other apps have their own paths.
  if (normalize(enriched.mobileApp) !== "whatsapp") {
    return null;
  }
  const sender = (enriched.sender ?? "").trim();
  const message = (enriched.message ?? "").trim();
  const base: Omit<WhatsAppReplyCandidate, "eligible" | "reason"> = {
    source: "phone_link",
    sender,
    message,
    notification: enriched,
  };

  switch (enriched.replyEligibility) {
    case "eligible":
      return { ...base, eligible: true, reason: "eligible" };
    case "group_blocked":
      return { ...base, eligible: false, reason: "group_blocked" };
    case "sensitive_blocked":
      return { ...base, eligible: false, reason: "sensitive_blocked" };
    default:
      return { ...base, eligible: false, reason: "ambiguous" };
  }
}

/**
 * Classifies a notification as a WhatsApp auto-reply candidate.
 * Returns `null` when the notification is not WhatsApp at all (nothing to do).
 */
export function classifyWhatsAppNotification(
  notification: StartTalkNotification,
): WhatsAppReplyCandidate | null {
  const appId = normalize(notification.appUserModelId);
  if (appId.startsWith("microsoft.yourphone_")) {
    return classifyPhoneLink(notification);
  }
  if (isWhatsAppDesktop(notification)) {
    return classifyDesktop(notification);
  }
  // Might still be WhatsApp arriving via Phone Link under a generic app id.
  const phoneLink = classifyPhoneLink(notification);
  return phoneLink;
}
