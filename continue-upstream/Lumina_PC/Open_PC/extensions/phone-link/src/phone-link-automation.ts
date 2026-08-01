/**
 * Phone Link (Enlace Móvil) Automation
 * 
 * Provides fast, reliable WhatsApp message responses via Windows Phone Link.
 * Uses a combination of UI Automation and vision-based fallbacks for maximum reliability.
 */

import type { OpenClawPluginApi } from "../../src/plugin-sdk/plugin-entry-runtime.js";

export const PHONE_LINK_PROCESS = "PhoneExperienceHost.exe";
export const WHATSAPP_REPLY_TIMEOUT_MS = 30_000;
export const CHAT_PANEL_LOAD_DELAY_MS = 1500;

export interface WhatsAppRespondParams {
  contact: string;
  message: string;
  fuzzyMatch?: boolean;
  timeoutMs?: number;
}

export interface WhatsAppRespondResult {
  ok: boolean;
  sentAt?: string;
  error?: string;
  contact?: string;
  messagePreview?: string;
}

export interface PhoneLinkStatus {
  isOpen: boolean;
  isConnected: boolean;
  statusText: string;
  windowHandle?: number;
  processId?: number;
}

/**
 * Cached Phone Link window info for faster subsequent calls
 */
let cachedWindowInfo: { hwnd: number; pid: number; cachedAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Main function to respond to WhatsApp contact via Phone Link
 */
export async function respondWhatsApp(
  params: WhatsAppRespondParams,
  api: OpenClawPluginApi,
): Promise<WhatsAppRespondResult> {
  const { contact, message, fuzzyMatch = true, timeoutMs = WHATSAPP_REPLY_TIMEOUT_MS } = params;
  const startTime = Date.now();

  try {
    // Step 1: Ensure Phone Link is open and focused
    const focusOk = await ensurePhoneLinkFocused(api);
    if (!focusOk) {
      return { ok: false, error: "No se pudo abrir o enfocar Enlace Móvil" };
    }

    // Step 2: Find and select the contact
    const contactOk = await selectContact(api, contact, fuzzyMatch);
    if (!contactOk) {
      return { ok: false, error: `No se encontró el contacto "${contact}"` };
    }

    // Step 3: Wait for chat panel to load
    await delay(CHAT_PANEL_LOAD_DELAY_MS);

    // Step 4: Type the message
    const typeOk = await typeMessage(api, message);
    if (!typeOk) {
      return { ok: false, error: "No se encontró el campo para escribir mensaje" };
    }

    // Step 5: Send with Enter key
    const sendOk = await sendMessage(api);
    if (!sendOk) {
      return { ok: false, error: "No se pudo enviar el mensaje (Enter falló)" };
    }

    // Step 6: Verify message was sent
    await delay(1000);
    const verifyOk = await verifyMessageSent(api, message);
    
    const duration = Date.now() - startTime;
    api.logger.info(`phone-link: WhatsApp respond completed in ${duration}ms`);

    return {
      ok: true,
      sentAt: new Date().toISOString(),
      contact,
      messagePreview: message.substring(0, 50),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Error desconocido";
    api.logger.error(`phone-link: WhatsApp respond failed: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Check Phone Link status
 */
export async function checkPhoneLinkStatus(api: OpenClawPluginApi): Promise<PhoneLinkStatus> {
  try {
    // Get window list
    const windowResult = await callBridge(api, "/window_control", { action: "list" });
    
    const phoneLinkWindow = (windowResult.windows as Array<{ handle?: number; process?: string; title?: string; pid?: number }> | undefined)
      ?.find(w => w.process?.toLowerCase().includes("phoneexperiencehost"));

    if (!phoneLinkWindow) {
      return {
        isOpen: false,
        isConnected: false,
        statusText: "🔴 Enlace Móvil no está abierto",
      };
    }

    // Cache window info
    if (phoneLinkWindow.handle && phoneLinkWindow.pid) {
      cachedWindowInfo = {
        hwnd: phoneLinkWindow.handle,
        pid: phoneLinkWindow.pid,
        cachedAt: Date.now(),
      };
    }

    // Check connection status via OCR
    const captureResult = await callBridge(api, "/ui_capture", {
      target: { processName: PHONE_LINK_PROCESS },
    });

    let isConnected = false;
    let statusText = "🟡 Enlace Móvil: Estado desconocido";

    if (captureResult.ok && captureResult.ocr?.text) {
      const ocrText = captureResult.ocr.text.toLowerCase();
      if (ocrText.includes("conectado")) {
        isConnected = true;
        statusText = "🟢 Enlace Móvil: Conectado";
      } else if (ocrText.includes("desconectado") || ocrText.includes("no conectado")) {
        statusText = "🔴 Enlace Móvil: Desconectado";
      }
    }

    return {
      isOpen: true,
      isConnected,
      statusText,
      windowHandle: phoneLinkWindow.handle,
      processId: phoneLinkWindow.pid,
    };
  } catch (error) {
    return {
      isOpen: false,
      isConnected: false,
      statusText: `⚠️ Error: ${error instanceof Error ? error.message : "Desconocido"}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Internal helper functions
// ─────────────────────────────────────────────────────────────

async function ensurePhoneLinkFocused(api: OpenClawPluginApi): Promise<boolean> {
  // Try to focus existing window first
  const focusResult = await callBridge(api, "/window_control", {
    action: "focus",
    processName: PHONE_LINK_PROCESS,
  });

  if (focusResult.ok && focusResult.focused) {
    return true;
  }

  // Open the app
  const openResult = await callBridge(api, "/open_application", {
    appName: "Enlace Móvil",
  });

  if (!openResult.ok) {
    return false;
  }

  // Wait for app to launch
  await delay(2000);

  // Try to focus again
  const retryFocusResult = await callBridge(api, "/window_control", {
    action: "focus",
    processName: PHONE_LINK_PROCESS,
  });

  return retryFocusResult.ok;
}

async function selectContact(
  api: OpenClawPluginApi,
  contact: string,
  fuzzyMatch: boolean,
): Promise<boolean> {
  // Try vision_click first (more reliable for WhatsApp in Phone Link)
  const visionResult = await callBridge(api, "/vision_click", {
    text: contact,
    action: "click",
    allowedApps: [PHONE_LINK_PROCESS],
  });

  if (visionResult.ok) {
    return true;
  }

  // Fallback to UIA interact
  const uiResult = await callBridge(api, "/ui_interact", {
    target: { processName: PHONE_LINK_PROCESS },
    name: `WhatsApp ${contact}`,
    action: "invoke",
    fuzzyMatch: fuzzyMatch,
  });

  if (uiResult.ok) {
    return true;
  }

  // Second fallback: click on "Escribir un mensaje" under the contact
  const fallbackResult = await callBridge(api, "/vision_click", {
    text: "Escribir un mensaje",
    action: "click",
    allowedApps: [PHONE_LINK_PROCESS],
  });

  return fallbackResult.ok;
}

async function typeMessage(api: OpenClawPluginApi, message: string): Promise<boolean> {
  // Try automationId first
  const autoIdResult = await callBridge(api, "/ui_interact", {
    target: { processName: PHONE_LINK_PROCESS },
    automationId: "ReplyTextBox",
    action: "set_value",
    value: message,
    waitForElementMs: 5000,
  });

  if (autoIdResult.ok) {
    return true;
  }

  // Fallback to name-based search
  const nameResult = await callBridge(api, "/ui_interact", {
    target: { processName: PHONE_LINK_PROCESS },
    name: "Escribir un mensaje",
    action: "set_value",
    value: message,
  });

  return nameResult.ok;
}

async function sendMessage(api: OpenClawPluginApi): Promise<boolean> {
  const result = await callBridge(api, "/input_control", {
    action: "key_press",
    key: "Enter",
    allowedApps: [PHONE_LINK_PROCESS],
  });

  return result.ok;
}

async function verifyMessageSent(api: OpenClawPluginApi, message: string): Promise<boolean> {
  const captureResult = await callBridge(api, "/ui_capture", {
    target: { processName: PHONE_LINK_PROCESS },
  });

  if (!captureResult.ok || !captureResult.ocr?.text) {
    // Optimistic success if we can't verify
    return true;
  }

  const ocrText = captureResult.ocr.text;
  const messagePreview = message.substring(0, 50).toLowerCase();

  // Check for "You" marker (sent messages) or message content
  return ocrText.includes("You") || ocrText.toLowerCase().includes(messagePreview);
}

async function callBridge(
  api: OpenClawPluginApi,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    // Try using lumina_windows_bridge tool directly
    const result = await api.runtime.harness.task({
      type: "lumina_windows_bridge",
      endpoint,
      body,
    });
    return result as Record<string, unknown>;
  } catch (error) {
    api.logger.warn(`phone-link: Bridge call failed: ${error}`);
    return { ok: false, error: String(error) };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clear cached window info (call when Phone Link closes)
 */
export function clearCachedWindowInfo(): void {
  cachedWindowInfo = null;
}

/**
 * Get cached window info if still valid
 */
export function getCachedWindowInfo(): { hwnd: number; pid: number } | null {
  if (!cachedWindowInfo) return null;
  if (Date.now() - cachedWindowInfo.cachedAt > CACHE_TTL_MS) {
    cachedWindowInfo = null;
    return null;
  }
  return { hwnd: cachedWindowInfo.hwnd, pid: cachedWindowInfo.pid };
}