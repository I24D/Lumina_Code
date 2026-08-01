import { describe, expect, it } from "vitest";

import type { StartTalkNotification } from "./types.js";
import { classifyWhatsAppNotification } from "./WhatsAppNotificationPolicy.js";

function desktop(
  title: string,
  body: string,
  overrides: Partial<StartTalkNotification> = {},
): StartTalkNotification {
  return {
    id: "wa-1",
    appName: "WhatsApp",
    appUserModelId: "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
    title,
    body,
    textElements: [title, body],
    createdAt: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}

function phoneLinkWhatsApp(textElements: string[]): StartTalkNotification {
  return {
    id: "pl-1",
    appName: "Enlace Movil",
    appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
    title: textElements[0] ?? "",
    body: textElements.slice(1).join(" "),
    textElements,
    createdAt: "2026-07-25T12:00:00.000Z",
  };
}

describe("classifyWhatsAppNotification — WhatsApp Desktop", () => {
  it("marks a direct message eligible", () => {
    expect(classifyWhatsAppNotification(desktop("Hugo", "¿Vienes hoy?"))).toMatchObject(
      {
        source: "whatsapp_desktop",
        sender: "Hugo",
        message: "¿Vienes hoy?",
        eligible: true,
        reason: "eligible",
      },
    );
  });

  it("blocks a group message (Sender: text body)", () => {
    expect(
      classifyWhatsAppNotification(desktop("Familia", "Ana: llego tarde")),
    ).toMatchObject({ eligible: false, reason: "group_blocked" });
  });

  it("blocks a group named in the title", () => {
    expect(
      classifyWhatsAppNotification(desktop("Grupo del trabajo", "hola a todos")),
    ).toMatchObject({ eligible: false, reason: "group_blocked" });
  });

  it("blocks a sensitive message", () => {
    expect(
      classifyWhatsAppNotification(desktop("Banco", "Tu código OTP es 123456")),
    ).toMatchObject({ eligible: false, reason: "sensitive_blocked" });
  });

  it("refuses aggregated summaries", () => {
    expect(
      classifyWhatsAppNotification(desktop("WhatsApp", "3 mensajes nuevos")),
    ).toMatchObject({ eligible: false, reason: "ambiguous" });
  });

  it("does not misread a direct message that merely contains a colon", () => {
    expect(
      classifyWhatsAppNotification(
        desktop("Hugo", "Recordatorio: nos vemos a las 5"),
      ),
    ).toMatchObject({ eligible: true, reason: "eligible" });
  });

  it("returns null for a non-WhatsApp notification", () => {
    expect(
      classifyWhatsAppNotification({
        id: "x",
        appName: "Slack",
        title: "Someone",
        body: "hi",
        createdAt: "2026-07-25T12:00:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("classifyWhatsAppNotification — Enlace móvil (Phone Link)", () => {
  it("marks a direct WhatsApp message eligible", () => {
    expect(
      classifyWhatsAppNotification(
        phoneLinkWhatsApp(["WhatsApp", "Hugo Tennessee", "Ke pasa"]),
      ),
    ).toMatchObject({
      source: "phone_link",
      sender: "Hugo Tennessee",
      message: "Ke pasa",
      eligible: true,
      reason: "eligible",
    });
  });

  it("blocks a WhatsApp group via Phone Link", () => {
    expect(
      classifyWhatsAppNotification(
        phoneLinkWhatsApp(["WhatsApp", "Equipo", "Ana: hola grupo"]),
      ),
    ).toMatchObject({ source: "phone_link", eligible: false });
  });

  it("returns null for a non-WhatsApp Phone Link message", () => {
    expect(
      classifyWhatsAppNotification(
        phoneLinkWhatsApp(["Telegram", "Hugo", "Hola"]),
      ),
    ).toBeNull();
  });
});
