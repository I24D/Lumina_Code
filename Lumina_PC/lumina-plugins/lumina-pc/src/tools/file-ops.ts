/**
 * file-ops.ts
 * Tool: lumina_file_ops
 *
 * File system operations for I24D: read, write, list, delete, move, exists.
 * Uses native Node.js fs — no extra dependencies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { compactToolResultForModel } from "../utils/tool-output-budget.js";

const ACTIONS = [
  "read",
  "write",
  "append",
  "list",
  "delete",
  "move",
  "copy",
  "exists",
  "stat",
] as const;
type FileAction = (typeof ACTIONS)[number];

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

function normalizeListWindow(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 0), max);
}

async function safeReadText(filePath: string, maxBytes = 512_000): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const truncated = bytesRead === maxBytes;
    return truncated ? text + "\n[...truncated — file larger than 512 KB]" : text;
  } finally {
    await handle.close();
  }
}

export function createFileOpsTool(): AnyAgentTool {
  return {
    name: "lumina_file_ops",
    description:
      "Performs file system operations on the local Windows PC: read a file, write/append text, list a directory, delete, move, copy, or check existence. " +
      "Paths can be absolute (C:\\Users\\...) or relative to the OpenClaw working directory.",
    parameters: Type.Object({
      action: Type.Union(
        ACTIONS.map((a) => Type.Literal(a)),
        {
          description:
            "Action to perform: read | write | append | list | delete | move | copy | exists | stat",
        },
      ),
      path: Type.String({
        description: "Target file or directory path.",
      }),
      content: Type.Optional(
        Type.String({
          description: "Content to write or append (required for write/append actions).",
        }),
      ),
      destination: Type.Optional(
        Type.String({
          description: "Destination path (required for move/copy actions).",
        }),
      ),
      recursive: Type.Optional(
        Type.Boolean({
          description: "For list: include subdirectories recursively. Default: false.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "For list: number of entries to return. Default: 200. Max: 500.",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "For list: zero-based offset for pagination. Default: 0.",
          minimum: 0,
        }),
      ),
      encoding: Type.Optional(
        Type.String({
          description: "Text encoding for read/write. Default: utf8.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const action = params.action as FileAction;
      const targetPath = params.path?.trim();
      if (!targetPath) throw new ToolInputError("path is required.");

      const resolved = path.resolve(targetPath);

      switch (action) {
        case "read": {
          try {
            const text = await safeReadText(resolved);
            return jsonResult({
              ok: true,
              path: resolved,
              content: compactToolResultForModel(text, { toolName: "lumina_file_ops.read" }),
            });
          } catch (err: unknown) {
            return jsonResult({ ok: false, path: resolved, error: String(err) });
          }
        }

        case "write": {
          if (params.content === undefined)
            throw new ToolInputError("content is required for write.");
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, params.content, params.encoding ?? "utf8");
          return jsonResult({
            ok: true,
            action: "write",
            path: resolved,
            bytes: Buffer.byteLength(params.content),
          });
        }

        case "append": {
          if (params.content === undefined)
            throw new ToolInputError("content is required for append.");
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.appendFile(resolved, params.content, params.encoding ?? "utf8");
          return jsonResult({ ok: true, action: "append", path: resolved });
        }

        case "list": {
          try {
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            const allItems = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file",
              path: path.join(resolved, e.name),
            }));
            const limit = Math.max(
              1,
              normalizeListWindow(params.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
            );
            const offset = normalizeListWindow(params.offset, 0, Number.MAX_SAFE_INTEGER);
            const page = allItems.slice(offset, offset + limit);
            const end = offset + page.length;
            const hasMore = end < allItems.length;
            const start = page.length === 0 ? 0 : offset + 1;
            const hint = hasMore
              ? `Showing entries ${start}-${end} of ${allItems.length}. For next page call with offset ${end} and limit ${limit}.`
              : `Showing entries ${start}-${end} of ${allItems.length}.`;
            return jsonResult({
              ok: true,
              path: resolved,
              count: page.length,
              totalCount: allItems.length,
              limit,
              offset,
              nextOffset: hasMore ? end : null,
              hasMore,
              hint,
              entries: page,
            });
          } catch (err: unknown) {
            return jsonResult({ ok: false, path: resolved, error: String(err) });
          }
        }

        case "delete": {
          try {
            const stat = await fs.stat(resolved);
            if (stat.isDirectory()) {
              await fs.rm(resolved, { recursive: true, force: true });
            } else {
              await fs.unlink(resolved);
            }
            return jsonResult({ ok: true, action: "delete", path: resolved });
          } catch (err: unknown) {
            return jsonResult({ ok: false, path: resolved, error: String(err) });
          }
        }

        case "move": {
          const dest = params.destination?.trim();
          if (!dest) throw new ToolInputError("destination is required for move.");
          const resolvedDest = path.resolve(dest);
          await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
          await fs.rename(resolved, resolvedDest);
          return jsonResult({ ok: true, action: "move", from: resolved, to: resolvedDest });
        }

        case "copy": {
          const dest = params.destination?.trim();
          if (!dest) throw new ToolInputError("destination is required for copy.");
          const resolvedDest = path.resolve(dest);
          await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
          await fs.copyFile(resolved, resolvedDest);
          return jsonResult({ ok: true, action: "copy", from: resolved, to: resolvedDest });
        }

        case "exists": {
          let exists = false;
          let type: string | null = null;
          try {
            const stat = await fs.stat(resolved);
            exists = true;
            type = stat.isDirectory() ? "dir" : "file";
          } catch {
            exists = false;
          }
          return jsonResult({ ok: true, path: resolved, exists, type });
        }

        case "stat": {
          try {
            const stat = await fs.stat(resolved);
            return jsonResult({
              ok: true,
              path: resolved,
              size_bytes: stat.size,
              is_directory: stat.isDirectory(),
              is_file: stat.isFile(),
              created: stat.birthtime.toISOString(),
              modified: stat.mtime.toISOString(),
              accessed: stat.atime.toISOString(),
            });
          } catch (err: unknown) {
            return jsonResult({ ok: false, path: resolved, error: String(err) });
          }
        }

        default:
          throw new ToolInputError(`Unknown action: ${action}`);
      }
    },
  };
}
