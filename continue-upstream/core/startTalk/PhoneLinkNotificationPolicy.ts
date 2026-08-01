import type { StartTalkNotification } from "./types.js";

const PHONE_LINK_APP_ID_PREFIX = "microsoft.yourphone_";
const PHONE_LINK_NAMES = new Set(["enlace movil", "phone link"]);
const SUPPORTED_MESSAGING_APPS = new Set([
  "facebook messenger",
  "google messages",
  "instagram",
  "messages",
  "messenger",
  "signal",
  "sms",
  "telegram",
  "whatsapp",
]);
const GROUP_TITLE_PATTERN = /\b(group|grupo|community|comunidad)\b/iu;
const GROUP_MESSAGE_PATTERN = /^[^:\n]{1,80}:\s+\S/u;
const AGGREGATE_PATTERN = /\b(\d+\s+(messages?|mensajes?|chats?)|new messages|mensajes nuevos)\b/iu;
const SENSITIVE_PATTERN =
  /\b(otp|one[- ]time|passcode|password|contrasena|contraseña|verification code|codigo de verificacion|código de verificación|security code|bank|banco|credit card|tarjeta de credito|tarjeta de crédito|wire transfer|transferencia|social security|ssn|money|dinero|payment|pago|pay|pagar|venmo|cash ?app|zelle|buy|comprar|sell|vender|appointment|cita|meeting|reunion|reunión|address|direccion|dirección)\b/iu;

function normalize(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function cleanElements(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.replace(/\s+/gu, " ").trim().slice(0, 1_000))
    .filter(Boolean)
    .slice(0, 8);
}

export function isPhoneLinkNotification(
  notification: Pick<StartTalkNotification, "appName" | "appUserModelId">,
): boolean {
  const appId = normalize(notification.appUserModelId);
  const appName = normalize(notification.appName);
  return (
    appId.startsWith(PHONE_LINK_APP_ID_PREFIX) ||
    PHONE_LINK_NAMES.has(appName)
  );
}

export function enrichPhoneLinkNotification(
  notification: StartTalkNotification,
): StartTalkNotification {
  if (!isPhoneLinkNotification(notification)) {
    return notification;
  }

  const textElements = cleanElements(notification.textElements);
  const mobileApp = textElements[0] ?? notification.title;
  const sender = textElements[1] ?? "";
  const message = textElements.slice(2).join(" ") || notification.body || "";
  const normalizedApp = normalize(mobileApp);
  const supportedMessagingApp = SUPPORTED_MESSAGING_APPS.has(normalizedApp);
  const looksAggregated = AGGREGATE_PATTERN.test(`${sender} ${message}`);
  const groupEvidence =
    GROUP_TITLE_PATTERN.test(sender) || GROUP_MESSAGE_PATTERN.test(message);
  const sensitive = SENSITIVE_PATTERN.test(`${sender} ${message}`);

  let conversationKind: StartTalkNotification["conversationKind"] =
    "not_applicable";
  let replyEligibility: StartTalkNotification["replyEligibility"] =
    "not_actionable";

  if (supportedMessagingApp) {
    if (looksAggregated || !sender || !message || textElements.length < 3) {
      conversationKind = "unknown";
      replyEligibility = "ambiguous";
    } else if (groupEvidence) {
      conversationKind = "group";
      replyEligibility = "group_blocked";
    } else if (sensitive) {
      conversationKind = "direct";
      replyEligibility = "sensitive_blocked";
    } else {
      conversationKind = "direct";
      replyEligibility = "eligible";
    }
  }

  return {
    ...notification,
    sourceKind: "phone_link",
    textElements,
    mobileApp,
    sender: sender || undefined,
    message: message || undefined,
    conversationKind,
    replyEligibility,
  };
}

export function validateAutomaticReplyText(value: unknown):
  | { ok: true; text: string }
  | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "reply_text_required" };
  }
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) {
    return { ok: false, error: "reply_text_required" };
  }
  if (text.length > 280) {
    return { ok: false, error: "reply_text_too_long" };
  }
  if (/https?:\/\/|www\./iu.test(text) || SENSITIVE_PATTERN.test(text)) {
    return { ok: false, error: "reply_text_sensitive" };
  }
  return { ok: true, text };
}
