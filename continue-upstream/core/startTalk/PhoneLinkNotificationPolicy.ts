import type { StartTalkNotification } from "./types.js";

const PHONE_LINK_APP_ID_PREFIX = "microsoft.yourphone_";
const PHONE_LINK_NAMES = new Set(["enlace movil", "phone link"]);
/**
 * Apps de mensajería cuyo nombre Phone Link antepone en el toast. Los nombres
 * en español estaban ausentes, así que en un Windows con ese idioma NINGUNA
 * notificación de "Mensajes" llegaba a clasificarse.
 */
const SUPPORTED_MESSAGING_APPS = new Set([
  "facebook messenger",
  "google messages",
  "instagram",
  "mensajeria",
  "mensajes",
  "mensajes de google",
  "messages",
  "messenger",
  "signal",
  "sms",
  "telegram",
  "whatsapp",
]);
/** Nombre que se le pone al SMS, porque Phone Link no lo incluye en el toast. */
const SMS_APP_LABEL = "SMS";
/**
 * Menos dígitos que esto y el remitente no es un teléfono: es un código corto
 * de operadora, banco o servicio de verificación. Se leen, pero contestarles no
 * lleva a ninguna parte, así que nunca son elegibles para respuesta.
 */
const MIN_PHONE_NUMBER_DIGITS = 10;
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

/** Un remitente que solo son dígitos y no llega a teléfono real. */
function isShortCodeSender(sender: string): boolean {
  if (/[a-z]/iu.test(sender)) {
    return false;
  }
  const digits = sender.replace(/\D/gu, "");
  return digits.length > 0 && digits.length < MIN_PHONE_NUMBER_DIGITS;
}

interface PhoneLinkParts {
  mobileApp: string;
  sender: string;
  message: string;
}

/**
 * Phone Link usa DOS formatos de toast y aquí solo se leía uno:
 *
 *   [app, remitente, mensaje]  → WhatsApp, Messenger, Telegram, Instagram…
 *   [remitente, mensaje]       → SMS: Windows no repite el nombre de la app
 *
 * Dar por hecho el primero metía el remitente en el hueco de la app y el
 * mensaje entero en el del remitente. Con eso `supportedMessagingApp` era
 * siempre falso para un SMS, así que ni se clasificaba ni pasaba por el filtro
 * de contenido sensible, y el texto viajaba duplicado al anuncio.
 */
function splitPhoneLinkElements(
  textElements: string[],
  notification: StartTalkNotification,
): PhoneLinkParts {
  const [first = "", second = "", ...rest] = textElements;

  if (SUPPORTED_MESSAGING_APPS.has(normalize(first))) {
    return { mobileApp: first, sender: second, message: rest.join(" ") };
  }
  if (textElements.length >= 2) {
    return {
      mobileApp: SMS_APP_LABEL,
      sender: first,
      message: [second, ...rest].join(" "),
    };
  }
  return {
    mobileApp: first || notification.title,
    sender: "",
    message: notification.body ?? "",
  };
}

export function enrichPhoneLinkNotification(
  notification: StartTalkNotification,
): StartTalkNotification {
  if (!isPhoneLinkNotification(notification)) {
    return notification;
  }

  const textElements = cleanElements(notification.textElements);
  const { mobileApp, sender, message } = splitPhoneLinkElements(
    textElements,
    notification,
  );
  const supportedMessagingApp = SUPPORTED_MESSAGING_APPS.has(
    normalize(mobileApp),
  );
  const looksAggregated = AGGREGATE_PATTERN.test(`${sender} ${message}`);
  const groupEvidence =
    GROUP_TITLE_PATTERN.test(sender) || GROUP_MESSAGE_PATTERN.test(message);
  const sensitive = SENSITIVE_PATTERN.test(`${sender} ${message}`);

  let conversationKind: StartTalkNotification["conversationKind"] =
    "not_applicable";
  let replyEligibility: StartTalkNotification["replyEligibility"] =
    "not_actionable";

  if (supportedMessagingApp) {
    if (looksAggregated || !sender || !message) {
      conversationKind = "unknown";
      replyEligibility = "ambiguous";
    } else if (groupEvidence) {
      conversationKind = "group";
      replyEligibility = "group_blocked";
    } else if (sensitive) {
      conversationKind = "direct";
      replyEligibility = "sensitive_blocked";
    } else if (isShortCodeSender(sender)) {
      // Operadora, banco o verificación: se lee en voz alta, no se contesta.
      conversationKind = "direct";
      replyEligibility = "not_actionable";
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
