import { describe, expect, it, vi } from "vitest";

import type { WhatsAppReplyCandidate } from "./WhatsAppNotificationPolicy.js";
import {
  WhatsAppAutoResponder,
  type AutoReplyAuditEntry,
} from "./WhatsAppAutoResponder.js";

function candidate(): WhatsAppReplyCandidate {
  return {
    source: "whatsapp_desktop",
    sender: "Ana",
    message: "Hola, ¿cómo estás?",
    eligible: true,
    reason: "eligible",
    notification: {
      id: "notification-1",
      appName: "WhatsApp",
      title: "Ana",
      body: "Hola, ¿cómo estás?",
      createdAt: "2026-08-25T00:00:00.000Z",
    },
  };
}

describe("WhatsAppAutoResponder", () => {
  it("creates a local suggestion and never reports it as sent", async () => {
    const entries: AutoReplyAuditEntry[] = [];
    const responder = new WhatsAppAutoResponder({
      generateReply: vi.fn().mockResolvedValue("¡Muy bien, gracias!"),
      authorizeCandidate: () => true,
      onAudit: (entry) => entries.push(entry),
    });

    await (
      responder as unknown as {
        replyTo: (
          value: WhatsAppReplyCandidate,
          senderKey: string,
        ) => Promise<void>;
      }
    ).replyTo(candidate(), "ana");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "suggested",
      reply: "¡Muy bien, gracias!",
      detail: "Borrador local; no enviado.",
    });
  });

  it("does not draft when ingress authorization rejects the sender", async () => {
    const generateReply = vi.fn().mockResolvedValue("Hola");
    const responder = new WhatsAppAutoResponder({
      generateReply,
      authorizeCandidate: () => false,
    });

    await (
      responder as unknown as {
        handleNotification: (
          value: WhatsAppReplyCandidate["notification"],
        ) => Promise<void>;
      }
    ).handleNotification(candidate().notification);

    expect(generateReply).not.toHaveBeenCalled();
  });
});
