/**
 * drive-tool.ts — Tool: lumina_drive
 *
 * Google Drive v3 REST. Actions: search, read (download), upload, share.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { googleFetch } from "./google-auth.js";

const ACTIONS = ["search", "read", "upload", "share"] as const;
type Action = (typeof ACTIONS)[number];

export function createDriveTool(): AnyAgentTool {
  return {
    name: "lumina_drive",
    label: "Lumina Drive",
    description:
      "Google Drive integration. Actions: search (Drive query syntax), read (download up to 1MB of text), " +
      "upload (multipart), share (add a permission). Default mimeType for uploads is text/plain.",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
      query: Type.Optional(Type.String({ maxLength: 480 })),
      fileId: Type.Optional(Type.String({ maxLength: 240 })),
      name: Type.Optional(Type.String({ maxLength: 240 })),
      mimeType: Type.Optional(Type.String({ maxLength: 120, default: "text/plain" })),
      content: Type.Optional(Type.String({ maxLength: 524_288 })),
      role: Type.Optional(
        Type.Union([Type.Literal("reader"), Type.Literal("writer"), Type.Literal("commenter")]),
      ),
      email: Type.Optional(Type.String({ maxLength: 240 })),
      max: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
    }),
    async execute(_id, params) {
      const action = params.action as Action;

      if (action === "search") {
        const q = params.query ?? "trashed=false";
        const max = params.max ?? 20;
        const r = await googleFetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,size,owners(displayName))`,
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        return jsonResult({ ok: true, ...(await r.json()) });
      }

      if (action === "read") {
        if (!params.fileId) throw new ToolInputError("fileId required for read");
        const r = await googleFetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}?alt=media`,
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        const buf = Buffer.from(await r.arrayBuffer());
        const truncated = buf.length > 1_048_576;
        const slice = truncated ? buf.subarray(0, 1_048_576) : buf;
        return jsonResult({
          ok: true,
          fileId: params.fileId,
          truncated,
          text: slice.toString("utf8"),
          bytes: buf.length,
        });
      }

      if (action === "upload") {
        const name = params.name;
        const content = params.content;
        if (!name) throw new ToolInputError("name required for upload");
        if (content === undefined) throw new ToolInputError("content required for upload");
        const mime = params.mimeType ?? "text/plain";
        const boundary = `lumina-${Date.now()}`;
        const metadata = JSON.stringify({ name, mimeType: mime });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: ${mime}\r\n\r\n${content}\r\n` +
          `--${boundary}--`;
        const r = await googleFetch(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
          {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body,
          },
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        return jsonResult({ ok: true, file: await r.json() });
      }

      if (action === "share") {
        if (!params.fileId) throw new ToolInputError("fileId required for share");
        if (!params.email) throw new ToolInputError("email required for share");
        const role = params.role ?? "reader";
        const r = await googleFetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.fileId)}/permissions`,
          {
            method: "POST",
            body: JSON.stringify({ type: "user", role, emailAddress: params.email }),
          },
        );
        if (!r.ok) return jsonResult({ ok: false, error: `${r.status} ${await r.text()}` });
        return jsonResult({ ok: true, permission: await r.json() });
      }

      throw new ToolInputError(`unknown action ${String(action)}`);
    },
  };
}
