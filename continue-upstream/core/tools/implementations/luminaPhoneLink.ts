import { ContextItem } from "../..";
import {
  callLuminaBridge,
  resolveLuminaBridgeUrl,
} from "../../luminaBridge/index.js";
import {
  enrichPhoneLinkNotification,
  isPhoneLinkNotification,
} from "../../startTalk/PhoneLinkNotificationPolicy.js";
import type { StartTalkNotification } from "../../startTalk/types.js";
import { ToolImpl } from ".";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeName(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Maps a raw /notifications/live record into the shape the classifier expects. */
function toStartTalkNotification(raw: Record<string, unknown>): StartTalkNotification {
  return {
    id: str(raw.notificationId) ?? str(raw.id) ?? "",
    appName: str(raw.appName) ?? "",
    appUserModelId: str(raw.appUserModelId),
    title: str(raw.title) ?? "",
    body: str(raw.body),
    createdAt: str(raw.createdAt) ?? "",
    textElements: Array.isArray(raw.textElements)
      ? (raw.textElements as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  };
}

/** Fetches current phone-message cards, enriched (sender/message/eligibility). */
async function readPhoneLinkCards(
  fetchFn: Parameters<ToolImpl>[1]["fetch"],
  bridgeUrl: string | undefined,
  fallbackBridgeUrl: string,
): Promise<StartTalkNotification[]> {
  const data = await callLuminaBridge(
    fetchFn,
    { endpoint: "/notifications/live", body: {}, bridgeUrl },
    fallbackBridgeUrl,
  );
  const list = Array.isArray((data as { notifications?: unknown }).notifications)
    ? ((data as { notifications: unknown[] }).notifications as unknown[])
    : [];
  return list
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    )
    .map(toStartTalkNotification)
    .filter((notification) => isPhoneLinkNotification(notification))
    .map((notification) => enrichPhoneLinkNotification(notification));
}

function publicCard(notification: StartTalkNotification) {
  return {
    sender: notification.sender ?? null,
    message: notification.message ?? null,
    mobileApp: notification.mobileApp ?? null,
    replyEligibility: notification.replyEligibility ?? null,
    conversationKind: notification.conversationKind ?? null,
    createdAt: notification.createdAt,
  };
}

async function handleRead(
  args: Record<string, unknown>,
  fetchFn: Parameters<ToolImpl>[1]["fetch"],
  bridgeUrl: string | undefined,
  fallbackBridgeUrl: string,
): Promise<ContextItem[]> {
  const cards = await readPhoneLinkCards(fetchFn, bridgeUrl, fallbackBridgeUrl);
  const limit = typeof args.limit === "number" ? args.limit : cards.length;
  return [
    {
      name: "Enlace móvil",
      description: "read",
      content: JSON.stringify(
        { ok: true, count: cards.length, cards: cards.slice(0, limit).map(publicCard) },
        null,
        2,
      ),
      status: "Phone Link cards read",
    },
  ];
}

async function handleReply(
  args: Record<string, unknown>,
  fetchFn: Parameters<ToolImpl>[1]["fetch"],
  bridgeUrl: string | undefined,
  fallbackBridgeUrl: string,
): Promise<ContextItem[]> {
  const sender = str(args.sender);
  const replyText = str(args.replyText);
  if (!sender || !replyText) {
    throw new Error(
      'lumina_phone_link action "reply" requires sender and replyText.',
    );
  }
  const wantedMessage = str(args.message);
  const cards = await readPhoneLinkCards(fetchFn, bridgeUrl, fallbackBridgeUrl);
  const senderKey = normalizeName(sender);
  const matches = cards.filter(
    (card) =>
      normalizeName(card.sender) === senderKey &&
      (!wantedMessage ||
        normalizeName(card.message).includes(normalizeName(wantedMessage))),
  );
  const target = matches[matches.length - 1];

  if (!target) {
    return [
      {
        name: "Enlace móvil",
        description: "reply (no match)",
        content: JSON.stringify(
          {
            ok: false,
            error: "no_matching_card",
            hint: "No pending Phone Link card matches that sender. Use action:read to see current cards.",
            available: cards.map(publicCard),
          },
          null,
          2,
        ),
        status: "No matching Phone Link card",
      },
    ];
  }

  if (target.replyEligibility !== "eligible") {
    return [
      {
        name: "Enlace móvil",
        description: "reply (blocked)",
        content: JSON.stringify(
          {
            ok: false,
            error: "reply_not_eligible",
            replyEligibility: target.replyEligibility,
            card: publicCard(target),
          },
          null,
          2,
        ),
        status: "Reply not eligible",
      },
    ];
  }

  const data = await callLuminaBridge(
    fetchFn,
    {
      endpoint: "/phone_link/reply",
      body: {
        notificationId: target.id,
        // The bridge validator (validatePhoneLinkReplyRequest) requires the
        // Phone Link app id and the conversationKind to prove this is a direct
        // Enlace móvil card — WhatsApp-from-phone included. Forward them from
        // the enriched card, or every send is rejected as source_is_not_phone_link.
        appUserModelId: target.appUserModelId,
        conversationKind: target.conversationKind,
        mobileApp: target.mobileApp,
        sender: target.sender,
        message: target.message,
        textElements: target.textElements,
        replyEligibility: target.replyEligibility,
        replyText,
        ...(args.dryRun === true ? { dryRun: true } : {}),
      },
      bridgeUrl,
    },
    fallbackBridgeUrl,
  );

  return [
    {
      name: "Enlace móvil",
      description: args.dryRun === true ? "reply (dryRun)" : "reply",
      content: JSON.stringify(data, null, 2),
      status: "Phone Link reply completed",
    },
  ];
}

export const luminaPhoneLinkImpl: ToolImpl = async (args, extras) => {
  const action = str(args.action) ?? "";
  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  const fallbackBridgeUrl = resolveLuminaBridgeUrl(workspaceDirs);
  const bridgeUrl = str(args.bridgeUrl);

  if (action === "read") {
    return handleRead(args, extras.fetch, bridgeUrl, fallbackBridgeUrl);
  }
  if (action === "reply") {
    return handleReply(args, extras.fetch, bridgeUrl, fallbackBridgeUrl);
  }
  throw new Error(
    `lumina_phone_link: unknown action "${action}". Use read or reply.`,
  );
};
