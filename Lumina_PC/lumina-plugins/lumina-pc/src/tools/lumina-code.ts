/**
 * lumina-code.ts
 * Tool: lumina_code
 *
 * Connects the OpenClaw chat agent to the installed Lumina Code extension in
 * VS Code through the local desktop bridge.
 */

import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";

const DEFAULT_LUMINA_CODE_BRIDGE_URL = "http://127.0.0.1:4321";
const ACTIONS = ["status", "open", "delegate"] as const;
type LuminaCodeAction = (typeof ACTIONS)[number];

function resolveBridgeUrl(): string {
  const configured = process.env.LUMINA_CODE_BRIDGE_URL?.trim();
  return (configured || DEFAULT_LUMINA_CODE_BRIDGE_URL).replace(/\/+$/, "");
}

export function createLuminaCodeTool(): AnyAgentTool {
  return {
    name: "lumina_code",
    description:
      "Connects to the installed Lumina Code coding agent in VS Code. " +
      "Use action=status when asked whether Lumina Code is available. " +
      "Use action=delegate only when the user explicitly asks for Lumina Code by name; never infer delegation merely because a request involves code, a repository, debugging, testing, or building. " +
      "Use action=open only when the user asks to open Lumina Code without assigning a coding task.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(ACTIONS.map((action) => Type.Literal(action)), {
          description: "Operation to perform: status | open | delegate. Default: status.",
        }),
      ),
      instruction: Type.Optional(
        Type.String({
          description: "Exact coding/development request to hand to Lumina Code. Required for delegate.",
          maxLength: 100_000,
        }),
      ),
      workspace_path: Type.Optional(
        Type.String({
          description:
            "Workspace folder for VS Code. If omitted, Lumina Code uses its configured workspace.",
        }),
      ),
    }),
    ownerOnly: true,
    async execute(_toolCallId: string, params) {
      const action = (params.action ?? "status") as LuminaCodeAction;
      if (!ACTIONS.includes(action)) {
        throw new ToolInputError(`Unknown action: ${String(action)}`);
      }

      const instruction = params.instruction?.trim();
      if (action === "delegate" && !instruction) {
        throw new ToolInputError("instruction is required for delegate.");
      }

      const method = action === "status" ? "GET" : "POST";
      const endpoint = action === "delegate" ? "delegate" : action;
      const requestBody =
        method === "POST"
          ? JSON.stringify({
              instruction,
              workspacePath: params.workspace_path?.trim() || undefined,
            })
          : undefined;

      try {
        const response = await fetch(`${resolveBridgeUrl()}/__lumina/code/${endpoint}`, {
          method,
          headers: {
            Origin: "lumina://localhost",
            ...(requestBody ? { "Content-Type": "application/json" } : {}),
          },
          body: requestBody,
        });
        const body = (await response.json()) as Record<string, unknown>;
        return jsonResult({
          ok: response.ok && body.ok !== false,
          action,
          ...body,
        });
      } catch (error: unknown) {
        return jsonResult({
          ok: false,
          action,
          error:
            error instanceof Error
              ? `Lumina Code bridge is not available: ${error.message}`
              : "Lumina Code bridge is not available.",
        });
      }
    },
  };
}
