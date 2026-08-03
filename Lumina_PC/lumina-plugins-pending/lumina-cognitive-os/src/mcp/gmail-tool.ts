/**
 * gmail-tool.ts — Tool: lumina_gmail
 *
 * Wraps the Gmail v1 REST API. Actions: list, read, send, draft, label.
 * Authentication comes from c:/I24D_WhatsApp/.env via google-auth.ts.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { googleFetch } from "./google-auth.js";

const ACTIONS = ["list", "read", "send", "draft", "label"] as const;
type Action = (typeof ACTIONS)[number];

function encodeBase64Url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function rfc2822(from: string, to: string, subject: string, body: string): string {
  return (
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `MIME-Version: 1.0\r\n` +
    `\r\n` +
    body
  );
}

export function createGmailTool(): AnyAgentTool {
  return {
    name: "lumina_gmail",
    label: "Lumina Gmail",
    description:
      "Gmail integration. Actions: list (search inbox), read (full message by id), send, draft, label. " +
      "Use 'list' with a Gmail search query like 'is:unread newer_than:1d'. Always confirm before send.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
      query: Type.Optional(Type.String({ maxLength: 480 })),
      max: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
      messageId: Type.Optional(Type.String({ maxLength: 64 })),
      to: Type.Optional(Type.String({ maxLength: 240 })),
      from: Type.Optional(Type.String({ maxLength: 240 })),
      subject: Type.Optional(Type.String({ maxLength: 480 })),
      body: Type.Optional(Type.String({ maxLength: 16_000 })),
      label: Type.Optional(Type.String({ maxLength: 60 })),
    }),
    async execute(_id, params) {
      const action = params.action as Action;
      const userId = "me";

      if (action === "list") {
        const q = params.query ?? "in:inbox";
        const max = params.max ?? 20;
        const r = await googleFetch(
          `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        const json = (await r.json()) as { messages?: Array<{ id: string; threadId: string }> };
        const ids = (json.messages ?? []).map((m) => m.id);
        // Fetch metadata in parallel
        const metas = await Promise.all(
          ids.map(async (id) => {
            const m = await googleFetch(
              `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            );
            if (!m.ok) return { id, error: m.status };
            const mj = (await m.json()) as {
              id: string;
              snippet?: string;
              labelIds?: string[];
              payload?: { headers?: Array<{ name: string; value: string }> };
              internalDate?: string;
            };
            const headers = mj.payload?.headers ?? [];
            const h = (n: string) =>
              headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
            return {
              id: mj.id,
              from: h("From"),
              subject: h("Subject"),
              date: h("Date"),
              snippet: mj.snippet ?? "",
              labels: mj.labelIds ?? [],
              ts: mj.internalDate,
            };
          }),
        );
        return jsonResult({ ok: true, count: metas.length, messages: metas });
      }

      if (action === "read") {
        if (!params.messageId) throw new ToolInputError("messageId required for read");
        const r = await googleFetch(
          `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/${params.messageId}?format=full`,
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        const json = (await r.json()) as {
          id: string;
          snippet?: string;
          payload?: {
            mimeType?: string;
            body?: { data?: string };
            parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
            headers?: Array<{ name: string; value: string }>;
          };
        };
        const headers = json.payload?.headers ?? [];
        const findHeader = (n: string) =>
          headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        let bodyText = "";
        const direct = json.payload?.body?.data;
        if (direct) {
          bodyText = decodeBase64Url(direct);
        } else if (json.payload?.parts) {
          const plain = json.payload.parts.find((p) => p.mimeType === "text/plain");
          if (plain?.body?.data) bodyText = decodeBase64Url(plain.body.data);
        }
        return jsonResult({
          ok: true,
          message: {
            id: json.id,
            from: findHeader("From"),
            to: findHeader("To"),
            subject: findHeader("Subject"),
            date: findHeader("Date"),
            snippet: json.snippet ?? "",
            bodyText: bodyText.slice(0, 16_000),
          },
        });
      }

      if (action === "send" || action === "draft") {
        const to = params.to;
        const subject = params.subject ?? "";
        const body = params.body ?? "";
        if (!to) throw new ToolInputError("to required for send/draft");
        if (!body) throw new ToolInputError("body required for send/draft");
        const from = params.from ?? "me";
        const raw = encodeBase64Url(rfc2822(from, to, subject, body));
        const endpoint =
          action === "send"
            ? `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/send`
            : `https://gmail.googleapis.com/gmail/v1/users/${userId}/drafts`;
        const payload =
          action === "send" ? { raw } : { message: { raw } };
        const r = await googleFetch(endpoint, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        const json = await r.json();
        return jsonResult({ ok: true, result: json });
      }

      if (action === "label") {
        if (!params.messageId) throw new ToolInputError("messageId required for label");
        if (!params.label) throw new ToolInputError("label required for label");
        const r = await googleFetch(
          `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages/${params.messageId}/modify`,
          { method: "POST", body: JSON.stringify({ addLabelIds: [params.label] }) },
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        return jsonResult({ ok: true, labeled: params.messageId });
      }

      throw new ToolInputError(`unknown action ${String(action)}`);
    },
  };
}
