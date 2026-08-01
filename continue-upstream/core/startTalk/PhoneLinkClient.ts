import type { StartTalkNotification } from "./types.js";

type PhoneLinkReplyPayload = {
  notification: StartTalkNotification;
  replyText: string;
  dryRun?: boolean;
};

export type PhoneLinkReplyResult = {
  ok: boolean;
  sent?: boolean;
  verified?: boolean;
  error?: string;
};

export class PhoneLinkClient {
  private readonly baseUrl: string;

  constructor(baseUrl = resolveBridgeUrl()) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
  }

  async reply({
    notification,
    replyText,
    dryRun = false,
  }: PhoneLinkReplyPayload): Promise<PhoneLinkReplyResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/phone_link/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: notification.id,
          appUserModelId: notification.appUserModelId,
          mobileApp: notification.mobileApp,
          sender: notification.sender,
          message: notification.message,
          textElements: notification.textElements,
          conversationKind: notification.conversationKind,
          replyEligibility: notification.replyEligibility,
          replyText,
          dryRun,
        }),
        signal: controller.signal,
      });
      const value = (await response.json()) as PhoneLinkReplyResult;
      if (!response.ok) {
        return { ok: false, error: value.error ?? `HTTP ${response.status}` };
      }
      return value;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveBridgeUrl(): string {
  return (
    process.env.LUMINA_WINDOWS_BRIDGE_URL ??
    process.env.LUMINA_BRIDGE_URL ??
    `http://127.0.0.1:${process.env.LUMINA_BRIDGE_PORT ?? "8765"}`
  );
}
