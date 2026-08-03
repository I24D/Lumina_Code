/**
 * browser-natural.ts — Playwright MCP-style natural language browser control.
 *
 * Inspired by Playwright MCP (Model Context Protocol) 2026:
 *   - Control browser via natural language instructions
 *   - Operates on accessibility tree, not screenshots
 *   - More reliable than vision-based approaches for web automation
 *
 * Tool: lumina_browser_natural
 *   Accepts high-level commands like:
 *   - "click the login button"
 *   - "fill the email field with test@example.com"
 *   - "search for 'playwright tutorial' and open the first result"
 *   - "scroll down and find the pricing section"
 *
 * The command is parsed to extract intent (click/type/search/scroll/navigate)
 * and target description, then executed using smart_click/smart_type primitives.
 */

import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";

function profileDir(profile: string): string {
  const base =
    process.env.APPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".lumina-cognitive-os");
  return path.join(base, "lumina-cognitive-os", "browser-profile", profile);
}

type SidecarResponse = { ok: boolean; [k: string]: unknown };

async function callSidecar(payload: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; data?: SidecarResponse; error?: string }> {
  return runPythonSidecarJson<SidecarResponse>(
    "browser_drive",
    [],
    { timeoutMs, stdin: JSON.stringify(payload) },
  );
}

export type BrowserNaturalConfig = { enabled: boolean };

/**
 * Parses a natural language command into an action + target + optional value.
 * Simple heuristic parser — production would use an LLM for better understanding.
 */
function parseNaturalCommand(cmd: string): { intent: string; target: string; value?: string; extra?: Record<string, unknown> } {
  const lower = cmd.toLowerCase().trim();
  
  // Navigation intents
  if (lower.startsWith("go to ") || lower.startsWith("open ") || lower.startsWith("navigate to ")) {
    const url = cmd.substring(cmd.indexOf(" ") + 1).trim();
    return { intent: "navigate", target: url };
  }
  
  if (lower.startsWith("back") || lower.includes("go back")) {
    return { intent: "navigate_back", target: "" };
  }
  
  if (lower.startsWith("forward") || lower.includes("go forward")) {
    return { intent: "navigate_forward", target: "" };
  }
  
  if (lower.startsWith("refresh") || lower.includes("reload")) {
    return { intent: "refresh", target: "" };
  }
  
  // Click intents
  if (lower.startsWith("click ") || lower.startsWith("tap ") || lower.startsWith("press ")) {
    const target = cmd.substring(cmd.indexOf(" ") + 1).trim();
    return { intent: "click", target };
  }
  
  // Type/fill intents
  if (lower.startsWith("type ") || lower.startsWith("fill ") || lower.startsWith("enter ")) {
    // Pattern: "type X into Y" or "fill Y with X" or "type X in Y"
    const intoMatch = lower.match(/^(?:type|fill)\s+(.+?)\s+(?:into|in|with)\s+(.+)$/i);
    if (intoMatch) {
      return { intent: "type", target: intoMatch[2].trim(), value: intoMatch[1].trim() };
    }
    // Pattern: "type X" (assumes single focused input)
    const simpleMatch = lower.match(/^type\s+(.+)$/i);
    if (simpleMatch && !simpleMatch[1].includes(" into ")) {
      return { intent: "type", target: "focused input", value: simpleMatch[1].trim() };
    }
  }
  
  // Search intents
  if (lower.startsWith("search for ") || lower.startsWith("find ")) {
    const query = cmd.substring(cmd.indexOf("for ") + 4).trim() || cmd.substring(cmd.indexOf("find ") + 5).trim();
    return { intent: "search", target: query };
  }
  
  // Scroll intents
  if (lower.startsWith("scroll down") || lower.startsWith("scroll up")) {
    const direction = lower.includes("up") ? "up" : "down";
    return { intent: "scroll", target: direction };
  }
  
  // Screenshot/info intents
  if (lower.includes("screenshot") || lower.includes("capture")) {
    return { intent: "screenshot", target: "" };
  }
  
  if (lower.startsWith("what") || lower.startsWith("read ") || lower.includes("what's on")) {
    return { intent: "read", target: "" };
  }
  
  // Default: assume it's a click target
  return { intent: "click", target: cmd.trim() };
}

export function createBrowserNaturalTool(opts: BrowserNaturalConfig): AnyAgentTool {
  return {
    name: "lumina_browser_natural",
    label: "Lumina Browser — Natural Language Control",
    description:
      "Controla el navegador con instrucciones en lenguaje natural (estilo Playwright MCP 2026). " +
      "Ejemplos: 'click the login button', 'fill email with test@example.com', 'search for playwright tutorial', " +
      "'scroll down', 'go to youtube.com'. Opera sobre el accessibility tree del DOM, no screenshots. " +
      "Devuelve { ok, intent, target, result }.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 500, description: "Instrucción en lenguaje natural." }),
      profile: Type.Optional(Type.String({ maxLength: 40, default: "default" })),
      headless: Type.Optional(Type.Boolean({ default: true })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 60_000, default: 8_000 })),
    }),
    async execute(_id, raw) {
      if (!opts.enabled) {
        return jsonResult({
          ok: false,
          error: "browser driver is disabled. Set browserDriverEnabled=true in plugin config.",
        });
      }
      
      const params = raw as {
        command: string;
        profile?: string;
        headless?: boolean;
        timeoutMs?: number;
      };
      
      const command = params.command?.trim();
      if (!command) throw new ToolInputError("command is required");
      
      // Parse natural language to structured action
      const parsed = parseNaturalCommand(command);
      
      const userDataDir = profileDir(params.profile?.trim() || "default");
      const timeoutMs = params.timeoutMs ?? 8_000;
      
      let payload: Record<string, unknown>;
      
      switch (parsed.intent) {
        case "navigate":
          payload = {
            action: "goto",
            userDataDir,
            args: { url: parsed.target, headless: params.headless !== false, timeoutMs },
          };
          break;
        
        case "navigate_back":
        case "navigate_forward":
        case "refresh":
          payload = {
            action: parsed.intent,
            userDataDir,
            args: { headless: params.headless !== false, timeoutMs },
          };
          break;
        
        case "click":
          payload = {
            action: "smart_click",
            userDataDir,
            args: { query: parsed.target, headless: params.headless !== false, timeoutMs },
          };
          break;
        
        case "type": {
          if (!parsed.value) {
            return jsonResult({ ok: false, error: "No text value provided for type action" });
          }
          // Special handling for "focused input" target
          const targetQuery = parsed.target === "focused input" ? "input" : parsed.target;
          payload = {
            action: "smart_type",
            userDataDir,
            args: { query: targetQuery, text: parsed.value, headless: params.headless !== false, timeoutMs },
          };
          break;
        }
        
        case "search": {
          // Search = go to Google + type query + press Enter
          // First check if we're already on a search engine
          payload = {
            action: "smart_type",
            userDataDir,
            args: { query: "search box", text: parsed.target, pressEnter: true, headless: params.headless !== false, timeoutMs },
          };
          break;
        }
        
        case "scroll": {
          const direction = parsed.target === "up" ? "up" : "down";
          payload = {
            action: "scroll",
            userDataDir,
            args: { direction, amount: 3, headless: params.headless !== false },
          };
          break;
        }
        
        case "screenshot":
          payload = {
            action: "dom_screenshot",
            userDataDir,
            args: { headless: params.headless !== false },
          };
          break;
        
        case "read":
          payload = {
            action: "read",
            userDataDir,
            args: { headless: params.headless !== false },
          };
          break;
        
        default:
          // Fallback: try as click
          payload = {
            action: "smart_click",
            userDataDir,
            args: { query: command, headless: params.headless !== false, timeoutMs },
          };
      }
      
      const r = await callSidecar(payload, Math.max(20_000, timeoutMs + 10_000));
      
      if (!r.ok) {
        return jsonResult({
          ok: false,
          error: r.error,
          hint: "If Playwright is missing run: pip install playwright && playwright install chromium",
        });
      }
      
      return jsonResult({
        ok: true,
        intent: parsed.intent,
        target: parsed.target,
        value: parsed.value,
        result: r.data,
      });
    },
  };
}
