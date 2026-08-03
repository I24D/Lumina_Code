export type PhoneLinkReplyRequest = {
  notificationId: string;
  appUserModelId: string;
  mobileApp: string;
  sender: string;
  message: string;
  textElements: string[];
  conversationKind: "direct";
  replyEligibility: "eligible";
  replyText: string;
  dryRun: boolean;
};

const PHONE_LINK_APP_ID_PREFIX = "microsoft.yourphone_";
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
const GROUP_MESSAGE_PATTERN = /^[^:\n]{1,80}:\s+\S/u;
const GROUP_OR_AGGREGATE_PATTERN =
  /\b(group|grupo|community|comunidad|\d+\s+(messages?|mensajes?|chats?))\b/iu;
const SENSITIVE_PATTERN =
  /\b(otp|one[- ]time|passcode|password|contrasena|contraseña|verification code|codigo de verificacion|código de verificación|security code|bank|banco|credit card|tarjeta de credito|tarjeta de crédito|wire transfer|transferencia|social security|ssn|money|dinero|payment|pago|pay|pagar|venmo|cash ?app|zelle|buy|comprar|sell|vender|appointment|cita|meeting|reunion|reunión|address|direccion|dirección)\b/iu;

function readText(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max)
    : "";
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLowerCase();
}

export function validatePhoneLinkReplyRequest(
  input: unknown,
): { ok: true; request: PhoneLinkReplyRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid_request" };
  }
  const record = input as Record<string, unknown>;
  const notificationId = readText(record, "notificationId", 300);
  const appUserModelId = readText(record, "appUserModelId", 300);
  const mobileApp = readText(record, "mobileApp", 100);
  const sender = readText(record, "sender", 200);
  const message = readText(record, "message", 1_000);
  const replyText = readText(record, "replyText", 1_000);
  const textElements = Array.isArray(record.textElements)
    ? record.textElements
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.replace(/\s+/gu, " ").trim().slice(0, 1_000))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (!notificationId || !sender || !message || !replyText) {
    return { ok: false, error: "missing_required_field" };
  }
  if (!normalize(appUserModelId).startsWith(PHONE_LINK_APP_ID_PREFIX)) {
    return { ok: false, error: "source_is_not_phone_link" };
  }
  if (!SUPPORTED_MESSAGING_APPS.has(normalize(mobileApp))) {
    return { ok: false, error: "unsupported_mobile_app" };
  }
  if (record.conversationKind !== "direct" || record.replyEligibility !== "eligible") {
    return { ok: false, error: "notification_not_eligible" };
  }
  if (textElements.length < 3 || normalize(textElements[1]) !== normalize(sender)) {
    return { ok: false, error: "notification_context_mismatch" };
  }
  if (
    GROUP_MESSAGE_PATTERN.test(message) ||
    GROUP_OR_AGGREGATE_PATTERN.test(`${sender} ${message}`)
  ) {
    return { ok: false, error: "group_or_aggregate_blocked" };
  }
  if (SENSITIVE_PATTERN.test(`${sender} ${message} ${replyText}`)) {
    return { ok: false, error: "sensitive_content_blocked" };
  }
  if (replyText.length > 280) {
    return { ok: false, error: "reply_text_too_long" };
  }
  if (/https?:\/\/|www\./iu.test(replyText)) {
    return { ok: false, error: "reply_link_blocked" };
  }

  return {
    ok: true,
    request: {
      notificationId,
      appUserModelId,
      mobileApp,
      sender,
      message,
      textElements,
      conversationKind: "direct",
      replyEligibility: "eligible",
      replyText,
      dryRun: record.dryRun === true,
    },
  };
}
