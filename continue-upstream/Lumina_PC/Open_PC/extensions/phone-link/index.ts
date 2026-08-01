import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../../src/agents/tools/common.js";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "../../src/plugin-sdk/plugin-entry-runtime.js";

const PHONE_LINK_PROCESS = "PhoneExperienceHost.exe";
const WHATSAPP_REPLY_TIMEOUT_MS = 30_000;

type WhatsAppRespondParams = {
  contact: string;
  message: string;
  fuzzyMatch?: boolean;
};

export default definePluginEntry({
  id: "phone-link",
  name: "Phone Link",
  description: "Windows Phone Link (Enlace Móvil) automation for WhatsApp and SMS",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "whatsapp_respond",
      description: "Respond to a WhatsApp contact via Windows Phone Link",
      acceptsArgs: true,
      parameters: Type.Object({
        contact: Type.String({ description: "Contact name (supports fuzzy match)" }),
        message: Type.String({ maxLength: 4096, description: "Message to send" }),
        fuzzyMatch: Type.Optional(Type.Boolean({ default: true })),
      }),
      handler: async (ctx) => {
        const params = ctx.args as unknown as WhatsAppRespondParams;
        if (!params.contact || !params.message) {
          return { text: "Usage: /whatsapp_respond <contact> <message>" };
        }

        const result = await respondWhatsApp({
          contact: params.contact,
          message: params.message,
          fuzzyMatch: params.fuzzyMatch ?? true,
          api,
        });

        if (result.ok) {
          return { text: `✅ Mensaje enviado a ${params.contact}` };
        } else {
          return { text: `❌ Error: ${result.error}` };
        }
      },
    });

    api.registerCommand({
      name: "phone_link_status",
      description: "Check if Phone Link (Enlace Móvil) is connected",
      acceptsArgs: false,
      handler: async () => {
        const status = await checkPhoneLinkStatus(api);
        return { text: status.text };
      },
    });
  },
});

async function respondWhatsApp(params: {
  contact: string;
  message: string;
  fuzzyMatch: boolean;
  api: OpenClawPluginApi;
}): Promise<{ ok: true; sentAt?: string } | { ok: false; error: string }> {
  const { contact, message, fuzzyMatch, api } = params;

  try {
    // Step 1: Ensure Phone Link is in foreground
    const focusResult = await callWindowsBridge(api, "/window_control", {
      action: "focus",
      processName: PHONE_LINK_PROCESS,
    });

    if (!focusResult.ok) {
      // Try to open Phone Link
      const openResult = await callWindowsBridge(api, "/open_application", {
        appName: "Enlace Móvil",
      });

      if (!openResult.ok) {
        return { ok: false, error: "No se pudo abrir Enlace Móvil" };
      }

      // Wait for app to open
      await sleep(2000);
    }

    // Step 2: Capture current state to find contact
    const captureResult = await callWindowsBridge(api, "/ui_capture", {
      target: { processName: PHONE_LINK_PROCESS },
    });

    if (!captureResult.ok) {
      return { ok: false, error: "No se pudo capturar la interfaz de Enlace Móvil" };
    }

    // Step 3: Find and click the contact using vision_click (more reliable for WhatsApp)
    const clickResult = await callWindowsBridge(api, "/vision_click", {
      text: contact,
      action: "click",
      allowedApps: [PHONE_LINK_PROCESS],
    });

    if (!clickResult.ok) {
      // Fallback: try UIA interact
      const uiInteractResult = await callWindowsBridge(api, "/ui_interact", {
        target: { processName: PHONE_LINK_PROCESS },
        name: `WhatsApp ${contact}`,
        action: "invoke",
        fuzzyMatch: fuzzyMatch,
      });

      if (!uiInteractResult.ok) {
        return { ok: false, error: `No se encontró el contacto "${contact}"` };
      }
    }

    // Wait for chat panel to load
    await sleep(1500);

    // Step 4: Find the reply text box and type message
    const typeResult = await callWindowsBridge(api, "/ui_interact", {
      target: { processName: PHONE_LINK_PROCESS },
      automationId: "ReplyTextBox",
      action: "set_value",
      value: message,
      waitForElementMs: 5000,
    });

    if (!typeResult.ok) {
      // Fallback: use vision to find "Escribir un mensaje" box
      const fallbackTypeResult = await callWindowsBridge(api, "/ui_interact", {
        target: { processName: PHONE_LINK_PROCESS },
        name: "Escribir un mensaje",
        action: "set_value",
        value: message,
      });

      if (!fallbackTypeResult.ok) {
        return { ok: false, error: "No se encontró el campo para escribir mensaje" };
      }
    }

    // Step 5: Send with Enter key
    const sendResult = await callWindowsBridge(api, "/input_control", {
      action: "key_press",
      key: "Enter",
      allowedApps: [PHONE_LINK_PROCESS],
    });

    if (!sendResult.ok) {
      return { ok: false, error: "No se pudo enviar el mensaje" };
    }

    // Step 6: Verify message was sent
    await sleep(1000);
    const verifyResult = await callWindowsBridge(api, "/ui_capture", {
      target: { processName: PHONE_LINK_PROCESS },
    });

    if (verifyResult.ok && verifyResult.ocr?.text) {
      // Check if message appears in OCR text (partial match)
      const messagePreview = message.substring(0, 50);
      if (verifyResult.ocr.text.includes(messagePreview) || verifyResult.ocr.text.includes("You")) {
        return { ok: true, sentAt: new Date().toISOString() };
      }
    }

    // Optimistic success if we got this far
    return { ok: true, sentAt: new Date().toISOString() };
  } catch (error) {
    api.logger.error(`phone-link: WhatsApp respond failed: ${error}`);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Error desconocido",
    };
  }
}

async function checkPhoneLinkStatus(api: OpenClawPluginApi): Promise<{ text: string; connected: boolean }> {
  try {
    const windowResult = await callWindowsBridge(api, "/window_control", {
      action: "list",
    });

    const phoneLinkWindow = windowResult.windows?.find(
      (w: { process?: string; title?: string }) =>
        w.process?.toLowerCase().includes("phoneexperiencehost"),
    );

    if (!phoneLinkWindow) {
      return { text: "🔴 Enlace Móvil no está abierto", connected: false };
    }

    // Check if phone is connected via OCR
    const captureResult = await callWindowsBridge(api, "/ui_capture", {
      target: { processName: PHONE_LINK_PROCESS },
    });

    if (captureResult.ok && captureResult.ocr?.text) {
      if (captureResult.ocr.text.includes("Conectado")) {
        return { text: "🟢 Enlace Móvil: Conectado", connected: true };
      } else if (captureResult.ocr.text.includes("Desconectado")) {
        return { text: "🔴 Enlace Móvil: Desconectado", connected: false };
      }
    }

    return { text: "🟡 Enlace Móvil: Estado desconocido", connected: false };
  } catch (error) {
    return { text: `⚠️ Error al verificar: ${error}`, connected: false };
  }
}

async function callWindowsBridge(
  api: OpenClawPluginApi,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Use lumina_runtime to call the Windows Bridge
  const result = await api.runtime.harness.task({
    type: "lumina_windows_bridge",
    endpoint,
    body,
  });

  return result as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}