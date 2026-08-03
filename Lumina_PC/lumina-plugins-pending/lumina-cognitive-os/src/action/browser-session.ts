/**
 * browser-session.ts — Tool: lumina_browser_session
 *
 * Manages persistent browser sessions using Playwright 1.59+ browser.bind() pattern.
 * Allows multiple agents to share the same browser session across calls.
 *
 * Use cases:
 *   - Multiple agents working on same browser tab (Codex opens, Claude analyzes)
 *   - Long-running browser automation that spans multiple agent turns
 *   - Shared authentication state across different workflows
 *
 * Session lifecycle:
 *   1. create_session — starts a new persistent browser session
 *   2. use_session — execute actions (goto, click, type, screenshot, etc.)
 *   3. close_session — cleanup when done
 *
 * Sessions auto-expire after 30 minutes of inactivity (configurable).
 * Cleanup runs automatically on every request (every 60s max).
 */

import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

function sessionsDir(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".lumina-browser-sessions");
  return path.join(base, "lumina-browser-sessions");
}

export function createBrowserSessionTool(): AnyAgentTool {
  return {
    name: "lumina_browser_session",
    label: "Lumina Browser Session Manager",
    description:
      "Manages persistent browser sessions using Playwright 1.59+ browser.bind() pattern. " +
      "Actions: create_session, use_session, close_session, list_sessions, session_status. " +
      "Enables multiple agents to share the same browser session with shared cookies/auth.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create_session"),
          Type.Literal("use_session"),
          Type.Literal("close_session"),
          Type.Literal("list_sessions"),
          Type.Literal("session_status"),
        ],
        { description: "Session management action." },
      ),
      sessionId: Type.Optional(Type.String({ maxLength: 64, description: "Unique session identifier." })),
      userDataDir: Type.Optional(Type.String({ maxLength: 512, description: "Custom user data directory for persistent cookies." })),
      headless: Type.Optional(Type.Boolean({ default: true, description: "Run browser in headless mode." })),
      // For use_session
      browserAction: Type.Optional(
        Type.Union(
          [
            Type.Literal("goto"),
            Type.Literal("click"),
            Type.Literal("type"),
            Type.Literal("screenshot"),
            Type.Literal("read"),
            Type.Literal("evaluate"),
            Type.Literal("navigate_back"),
            Type.Literal("navigate_forward"),
            Type.Literal("wait_for_load"),
          ],
          { description: "Browser action to execute within the session." },
        ),
      ),
      url: Type.Optional(Type.String({ maxLength: 2048, description: "URL for goto action." })),
      selector: Type.Optional(Type.String({ maxLength: 512, description: "CSS selector for click/type actions." })),
      text: Type.Optional(Type.String({ maxLength: 4096, description: "Text to type." })),
      pressEnter: Type.Optional(Type.Boolean({ description: "Press Enter after typing." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Full page screenshot." })),
      javascript: Type.Optional(Type.String({ description: "JavaScript code for evaluate action." })),
      waitUntil: Type.Optional(
        Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")]),
      ),
      timeoutMs: Type.Optional(Type.Number({ minimum: 500, maximum: 60_000, default: 5000 })),
    }),
    async execute(_id, params) {
      const action = params.action as string;
      const sessionId = params.sessionId?.trim();
      
      // Validate required params per action
      if (action === "create_session" && !sessionId) {
        throw new ToolInputError("sessionId is required for create_session");
      }
      if (action === "close_session" && !sessionId) {
        throw new ToolInputError("sessionId is required for close_session");
      }
      if (action === "session_status" && !sessionId) {
        throw new ToolInputError("sessionId is required for session_status");
      }
      if (action === "use_session") {
        if (!sessionId) {
          throw new ToolInputError("sessionId is required for use_session");
        }
        if (!params.browserAction) {
          throw new ToolInputError("browserAction is required for use_session");
        }
        if (params.browserAction === "goto" && !params.url) {
          throw new ToolInputError("url is required for goto action");
        }
        if ((params.browserAction === "click" || params.browserAction === "type") && !params.selector) {
          throw new ToolInputError("selector is required for click/type action");
        }
        if (params.browserAction === "type" && params.text === undefined) {
          throw new ToolInputError("text is required for type action");
        }
      }

      const payload: Record<string, unknown> = {
        action,
        session_id: sessionId,
        args: {},
      };

      // Build args based on action
      if (action === "create_session") {
        payload.args = {
          userDataDir: params.userDataDir || path.join(sessionsDir(), sessionId!),
          headless: params.headless ?? true,
        };
      } else if (action === "use_session") {
        payload.args = {
          action: params.browserAction,
          url: params.url,
          selector: params.selector,
          text: params.text,
          pressEnter: params.pressEnter,
          fullPage: params.fullPage,
          javascript: params.javascript,
          waitUntil: params.waitUntil,
          timeoutMs: params.timeoutMs,
        };
      }

      const r = await runPythonSidecarJson<{ ok: boolean; [k: string]: unknown }>(
        "browser_session",
        [],
        { timeoutMs: 30_000, stdin: JSON.stringify(payload) },
      );

      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint: "Ensure Python sidecar is running: python sidecars/browser_session.py",
        });
      }

      return jsonResult(r.data);
    },
  };
}
