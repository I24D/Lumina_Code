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
