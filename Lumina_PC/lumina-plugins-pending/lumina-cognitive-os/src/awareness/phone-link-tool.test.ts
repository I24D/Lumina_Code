import { describe, expect, it } from "vitest";
import type { BridgeClient } from "../shared/bridge-client.js";
import {
  createPhoneLinkReplyTool,
  createPhoneLinkStatusTool,
} from "./phone-link-tool.js";

function bridgeReturning(value: unknown, calls: unknown[] = []): BridgeClient {
  return {
    bridgeUrl: "http://127.0.0.1:8765",
    get: async () => value,
    post: async (_path, body) => {
      calls.push(body);
      return value;
    },
  };
}

describe("Phone Link tools", () => {
  it("reports the live Phone Link connection", async () => {
    const tool = createPhoneLinkStatusTool(
      bridgeReturning({ ok: true, connected: true, notificationFeedReady: true }),
    );
    const result = await tool.execute("test", {});
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      ok: true,
      connected: true,
      notificationFeedReady: true,
    });
  });

  it("requires confirmation for agent-initiated replies", async () => {
    const calls: unknown[] = [];
    const tool = createPhoneLinkReplyTool(bridgeReturning({ ok: true }, calls));
    const result = await tool.execute("test", {
      notificationId: "phone-link-1",
      appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
      mobileApp: "WhatsApp",
      sender: "Hugo Tennessee",
      message: "Ke pasa",
      textElements: ["WhatsApp", "Hugo Tennessee", "Ke pasa"],
      conversationKind: "direct",
      replyEligibility: "eligible",
      replyText: "Todo bien, gracias.",
      confirmed: false,
    });

    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      refused: "needs_confirmation",
    });
    expect(calls).toHaveLength(0);
  });

  it("forwards one confirmed direct reply to the Bridge", async () => {
    const calls: unknown[] = [];
    const tool = createPhoneLinkReplyTool(
      bridgeReturning({ ok: true, sent: true, verified: true }, calls),
    );
    await tool.execute("test", {
      notificationId: "phone-link-1",
      appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
      mobileApp: "WhatsApp",
      sender: "Hugo Tennessee",
      message: "Ke pasa",
      textElements: ["WhatsApp", "Hugo Tennessee", "Ke pasa"],
      conversationKind: "direct",
      replyEligibility: "eligible",
      replyText: "Todo bien, gracias.",
      confirmed: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationKind: "direct",
      replyEligibility: "eligible",
      replyText: "Todo bien, gracias.",
    });
  });
});
