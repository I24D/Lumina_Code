import { describe, expect, it } from "vitest";
import type { StartTalkNotification } from "core/startTalk";

import {
  buildPhoneAssistantBridgePrompt,
  isPhoneBridgeEligible,
  sanitizeWakeWord,
  selectPhoneBridgeNotifications,
} from "./phoneAssistantBridge";

function notification(
  overrides: Partial<StartTalkNotification>,
): StartTalkNotification {
  return {
    id: "n1",
    appName: "WhatsApp",
    createdAt: new Date(0).toISOString(),
    textElements: [],
    sourceKind: "phone_link",
    sender: "Ana",
    message: "Hola",
    conversationKind: "direct",
    replyEligibility: "eligible",
    ...overrides,
  } as StartTalkNotification;
}

describe("sanitizeWakeWord", () => {
  it("falls back to the default when empty", () => {
    expect(sanitizeWakeWord("")).toBe("OK Google");
    expect(sanitizeWakeWord(undefined)).toBe("OK Google");
  });

  it("keeps a valid phrase and strips quotes/newlines", () => {
    expect(sanitizeWakeWord("  Hey Google  ")).toBe("Hey Google");
    expect(sanitizeWakeWord('Ok "Google"\n')).toBe("Ok Google");
  });
});

describe("isPhoneBridgeEligible", () => {
  it("matches verified direct phone-link messaging apps", () => {
    expect(isPhoneBridgeEligible(notification({ mobileApp: "WhatsApp" }))).toBe(
      true,
    );
    expect(isPhoneBridgeEligible(notification({ appName: "Messenger" }))).toBe(
      true,
    );
  });

  it("blocks groups, ambiguous messages, sensitive messages and non-phone sources", () => {
    expect(
      isPhoneBridgeEligible(
        notification({
          conversationKind: "group",
          replyEligibility: "group_blocked",
        }),
      ),
    ).toBe(false);
    expect(
      isPhoneBridgeEligible(
        notification({
          conversationKind: "unknown",
          replyEligibility: "ambiguous",
        }),
      ),
    ).toBe(false);
    expect(
      isPhoneBridgeEligible(
        notification({ replyEligibility: "sensitive_blocked" }),
      ),
    ).toBe(false);
    expect(isPhoneBridgeEligible(notification({ sourceKind: "windows" }))).toBe(
      false,
    );
  });

  it("ignores unrelated apps", () => {
    expect(
      isPhoneBridgeEligible(
        notification({ appName: "Visual Studio Code", mobileApp: "" }),
      ),
    ).toBe(false);
  });
});

describe("buildPhoneAssistantBridgePrompt", () => {
  it("embeds the wake word and the untrusted-data guard", () => {
    const prompt = buildPhoneAssistantBridgePrompt(
      [
        notification({
          mobileApp: "WhatsApp",
          sender: "Ana",
          message: "¿Vienes hoy?",
        }),
      ],
      { wakeWord: "OK Google" },
    );

    expect(prompt).toContain("Phone Assistant Bridge");
    expect(prompt).toContain("untrusted notification data");
    expect(prompt).toContain('wakeWord: "OK Google"');
    expect(prompt).toContain(
      "abre [application] y responde el mensaje de [sender]",
    );
    expect(prompt).toContain("provide a short, natural, low-risk reply");
    // The notification content is carried as data, not as instructions.
    expect(prompt).toContain('"sender":"Ana"');
    // It must not fall back to the Phone Link reply tool for this path.
    expect(prompt).toContain("Do not call reply_to_phone_link");
  });

  it("clamps the attempt count into a safe range", () => {
    const prompt = buildPhoneAssistantBridgePrompt(
      [notification({ mobileApp: "WhatsApp" })],
      { maxAttempts: 99 },
    );
    expect(prompt).toContain("more than 4 times");
  });
});

describe("selectPhoneBridgeNotifications", () => {
  it("keeps only bridge-eligible notifications", () => {
    const list = [
      notification({ id: "a", mobileApp: "WhatsApp" }),
      notification({ id: "b", appName: "Slack", mobileApp: "" }),
      notification({
        id: "c",
        mobileApp: "WhatsApp",
        conversationKind: "group",
        replyEligibility: "group_blocked",
      }),
    ];
    expect(selectPhoneBridgeNotifications(list).map((n) => n.id)).toEqual([
      "a",
    ]);
  });
});
