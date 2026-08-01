import { ContextItem } from "../..";
import {
  callLuminaBridge,
  resolveLuminaBridgeUrl,
  type LuminaBridgeCallArgs,
  type LuminaBridgeEndpoint,
} from "../../luminaBridge/index.js";
import { ToolImpl } from ".";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Maps each semantic WhatsApp action to its deterministic bridge endpoint plus
// the body it expects. Keeping this table here is what lets the agent say
// `{ action: "reply", contact, message }` instead of hand-assembling endpoints.
function resolveWhatsAppCall(args: Record<string, unknown>): {
  endpoint: LuminaBridgeEndpoint;
  body: Record<string, unknown>;
} {
  const action = str(args.action) ?? "";
  const contact = str(args.contact);
  const limit = num(args.limit);
  const dryRun = args.dryRun === true;

  switch (action) {
    case "find_contact":
      return {
        endpoint: "/whatsapp/contacts",
        body: {
          ...(str(args.query) ? { query: str(args.query) } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(args.unreadOnly === true ? { unreadOnly: true } : {}),
          ...(args.includePreviews === true ? { includePreviews: true } : {}),
        },
      };
    case "read":
      if (!contact) {
        throw new Error('lumina_whatsapp action "read" requires a contact.');
      }
      return {
        endpoint: "/whatsapp/messages",
        body: { contact, ...(limit !== undefined ? { limit } : {}) },
      };
    case "reply":
      if (!contact || (!str(args.message) && !str(args.mediaPath))) {
        throw new Error(
          'lumina_whatsapp action "reply" requires a contact and a message or mediaPath.',
        );
      }
      return {
        endpoint: "/whatsapp/reply",
        body: {
          contact,
          ...(str(args.message) ? { message: str(args.message) } : {}),
          ...(str(args.mediaPath) ? { mediaPath: str(args.mediaPath) } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        },
      };
    case "list_statuses":
      return {
        endpoint: "/whatsapp/statuses",
        body: { ...(limit !== undefined ? { limit } : {}) },
      };
    case "publish_status":
      return {
        endpoint: "/whatsapp/status",
        body: {
          ...(str(args.message) ? { text: str(args.message) } : {}),
          ...(str(args.mediaPath) ? { mediaPath: str(args.mediaPath) } : {}),
          ...(str(args.caption) ? { caption: str(args.caption) } : {}),
          ...(str(args.background) ? { background: str(args.background) } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        },
      };
    default:
      throw new Error(
        `lumina_whatsapp: unknown action "${action}". Use find_contact, read, reply, list_statuses, or publish_status.`,
      );
  }
}

export const luminaWhatsAppImpl: ToolImpl = async (args, extras) => {
  const { endpoint, body } = resolveWhatsAppCall(args);
  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  const fallbackBridgeUrl = resolveLuminaBridgeUrl(workspaceDirs);
  const callArgs: LuminaBridgeCallArgs = {
    endpoint,
    body,
    bridgeUrl: str(args.bridgeUrl),
  };
  const data = await callLuminaBridge(extras.fetch, callArgs, fallbackBridgeUrl);
  const contextItem: ContextItem = {
    name: "WhatsApp Desktop",
    description: `${str(args.action)} ${endpoint}`,
    content: JSON.stringify(data, null, 2),
    status: "WhatsApp call completed",
  };
  return [contextItem];
};
