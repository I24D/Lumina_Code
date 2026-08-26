import { describe, expect, it } from "vitest";

import {
  enrichPhoneLinkNotification,
  validateAutomaticReplyText,
} from "./PhoneLinkNotificationPolicy.js";
import type { StartTalkNotification } from "./types.js";

function phoneLinkNotification(textElements: string[]): StartTalkNotification {
  return {
    id: "phone-link-1",
    appName: "Enlace Movil",
    appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
    title: textElements[0] ?? "",
    body: textElements.slice(1).join(" "),
    textElements,
    createdAt: "2026-07-18T12:00:00.000Z",
  };
}

describe("enrichPhoneLinkNotification", () => {
  it("allows a non-sensitive direct WhatsApp notification", () => {
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification(["WhatsApp", "Hugo Tennessee", "Ke pasa"]),
      ),
    ).toMatchObject({
      sourceKind: "phone_link",
      mobileApp: "WhatsApp",
      sender: "Hugo Tennessee",
      message: "Ke pasa",
      conversationKind: "direct",
      replyEligibility: "eligible",
    });
  });

  it("no confunde unos dos puntos en mitad de una frase con un grupo", () => {
    // Caso real: el asistente del usuario le escribe por Telegram y el mensaje
    // lleva dos puntos antes de una lista. Se marcaba como grupo, y con eso
    // quedaba bloqueado para responder aunque el usuario lo autorizara.
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification([
          "Telegram",
          "Lumina OpenClaw",
          "Sí, estoy listo y activo. Todas las reglas están en mi memoria:\n1. Informe hecho",
        ]),
      ),
    ).toMatchObject({
      conversationKind: "direct",
      replyEligibility: "eligible",
    });
  });

  it("sigue reconociendo el prefijo de quien habla en un grupo", () => {
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification([
          "Telegram",
          "Equipo Lumina",
          "Marta: ya subi los cambios",
        ]),
      ).replyEligibility,
    ).toBe("group_blocked");
  });

  it("blocks WhatsApp group notifications", () => {
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification([
          "WhatsApp",
          "Familia",
          "Maria: Ya llegaron todos",
        ]),
      ),
    ).toMatchObject({
      conversationKind: "group",
      replyEligibility: "group_blocked",
    });
  });

  it("reads an SMS toast that does not name the mobile app", () => {
    // Phone Link manda los SMS como [remitente, mensaje]: sin este caso el
    // remitente acababa en el hueco de la app y el mensaje en el del remitente.
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification(["Hugo Tennessee", "Ya voy saliendo"]),
      ),
    ).toMatchObject({
      mobileApp: "SMS",
      sender: "Hugo Tennessee",
      message: "Ya voy saliendo",
      conversationKind: "direct",
      replyEligibility: "eligible",
    });
  });

  it("classifies a carrier short code as unanswerable, not unknown", () => {
    const notification = enrichPhoneLinkNotification(
      phoneLinkNotification([
        "1113114",
        "Es Cricket. Tu cuenta ya no incluye el plan de HBO Max.",
      ]),
    );

    expect(notification.sender).toBe("1113114");
    expect(notification.message).toBe(
      "Es Cricket. Tu cuenta ya no incluye el plan de HBO Max.",
    );
    expect(notification.replyEligibility).toBe("not_actionable");
  });

  it("runs the sensitive filter on text messages too", () => {
    // Antes ningún SMS llegaba a clasificarse, asi que un aviso de pago pasaba
    // como "no accionable" sin que el filtro de sensibles llegara a mirarlo.
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification([
          "1113114",
          "Realiza tu pago de $60.00 hoy antes de las 11:59 P.M.",
        ]),
      ).replyEligibility,
    ).toBe("sensitive_blocked");
  });

  it("understands the Spanish name of the messages app", () => {
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification(["Mensajes", "Hugo Tennessee", "Ke pasa"]),
      ),
    ).toMatchObject({
      mobileApp: "Mensajes",
      sender: "Hugo Tennessee",
      replyEligibility: "eligible",
    });
  });

  it("blocks ambiguous and sensitive notifications", () => {
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification(["WhatsApp", "3 mensajes de 2 chats"]),
      ).replyEligibility,
    ).toBe("ambiguous");
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification([
          "WhatsApp",
          "Banco",
          "Tu codigo de verificacion es 123456",
        ]),
      ).replyEligibility,
    ).toBe("sensitive_blocked");
    expect(
      enrichPhoneLinkNotification(
        phoneLinkNotification([
          "WhatsApp",
          "Hugo Tennessee",
          "Me prestas dinero hoy?",
        ]),
      ).replyEligibility,
    ).toBe("sensitive_blocked");
  });
});

describe("validateAutomaticReplyText", () => {
  it("accepts a short low-risk reply", () => {
    expect(validateAutomaticReplyText("Hola, estoy bien. Gracias.")).toEqual({
      ok: true,
      text: "Hola, estoy bien. Gracias.",
    });
  });

  it("blocks links and sensitive reply content", () => {
    expect(validateAutomaticReplyText("Mira https://example.com")).toEqual({
      ok: false,
      error: "reply_text_sensitive",
    });
    expect(validateAutomaticReplyText("Mi password es secreto")).toEqual({
      ok: false,
      error: "reply_text_sensitive",
    });
  });
});
