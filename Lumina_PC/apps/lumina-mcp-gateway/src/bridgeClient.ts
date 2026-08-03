import { config } from "./config.ts";

/**
 * Thin HTTP client for the Lumina Windows Bridge (native PC actions on :8765).
 * Every MCP tool that touches the PC (WhatsApp, UI automation, screenshots,
 * system context) goes through here so the gateway never re-implements bridge
 * logic — it only forwards.
 */

export interface BridgeResult {
  ok: boolean;
  status: number;
  data: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function bridgePost(
  path: string,
  body: unknown,
  timeoutMs = 30_000,
): Promise<BridgeResult> {
  try {
    const response = await fetch(`${config.bridgeUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await readJson(response),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "bridge_unreachable",
        detail: error instanceof Error ? error.message : String(error),
        hint: "El Windows Bridge (:8765) no respondió. ¿Está corriendo el Dev Host / dev:all?",
      },
    };
  }
}

export async function bridgeGet(
  path: string,
  timeoutMs = 15_000,
): Promise<BridgeResult> {
  try {
    const response = await fetch(`${config.bridgeUrl}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await readJson(response),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "bridge_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
