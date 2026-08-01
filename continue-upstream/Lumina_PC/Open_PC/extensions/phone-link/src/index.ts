/**
 * Phone Link Extension Entry Point
 * 
 * Windows Phone Link (Enlace Móvil) automation for WhatsApp and SMS notifications.
 * Provides fast, reliable message responses with fuzzy contact matching and automatic verification.
 */

export {
  respondWhatsApp,
  checkPhoneLinkStatus,
  clearCachedWindowInfo,
  getCachedWindowInfo,
  PHONE_LINK_PROCESS,
  WHATSAPP_REPLY_TIMEOUT_MS,
  CHAT_PANEL_LOAD_DELAY_MS,
  type WhatsAppRespondParams,
  type WhatsAppRespondResult,
  type PhoneLinkStatus,
} from "./phone-link-automation.js";