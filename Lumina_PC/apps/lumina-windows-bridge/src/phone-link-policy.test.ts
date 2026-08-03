import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validatePhoneLinkReplyRequest } from "./phone-link-policy.ts";

function request(overrides: Record<string, unknown> = {}) {
  return {
    notificationId: "phone-link-1",
    appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
    mobileApp: "WhatsApp",
    sender: "Hugo Tennessee",
    message: "Ke pasa",
    textElements: ["WhatsApp", "Hugo Tennessee", "Ke pasa"],
    conversationKind: "direct",
    replyEligibility: "eligible",
    replyText: "Todo bien, gracias.",
    ...overrides,
  };
}

describe("validatePhoneLinkReplyRequest", () => {
  it("accepts an eligible direct WhatsApp reply", () => {
    const result = validatePhoneLinkReplyRequest(request());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.request.sender, "Hugo Tennessee");
  });

  it("blocks group, ambiguous, and mismatched notification context", () => {
    assert.deepEqual(
      validatePhoneLinkReplyRequest(
        request({ message: "Maria: hola", textElements: ["WhatsApp", "Familia", "Maria: hola"], sender: "Familia" }),
      ),
      { ok: false, error: "group_or_aggregate_blocked" },
    );
    assert.deepEqual(
      validatePhoneLinkReplyRequest(request({ conversationKind: "unknown" })),
      { ok: false, error: "notification_not_eligible" },
    );
    assert.deepEqual(
      validatePhoneLinkReplyRequest(request({ sender: "Otro" })),
      { ok: false, error: "notification_context_mismatch" },
    );
  });

  it("blocks sensitive or link-bearing replies", () => {
    assert.deepEqual(
      validatePhoneLinkReplyRequest(request({ replyText: "Mi password es secreto" })),
      { ok: false, error: "sensitive_content_blocked" },
    );
    assert.deepEqual(
      validatePhoneLinkReplyRequest(request({ replyText: "Mira https://example.com" })),
      { ok: false, error: "reply_link_blocked" },
    );
    assert.deepEqual(
      validatePhoneLinkReplyRequest(request({ message: "Me prestas dinero hoy?" })),
      { ok: false, error: "sensitive_content_blocked" },
    );
  });
});
