import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import type { FetchFunction } from "../index.js";

export const DEFAULT_LUMINA_BRIDGE_URL = "http://127.0.0.1:8765";

const GET_ENDPOINTS = new Set([
  "/health",
  "/processes",
  "/camera_devices",
  "/logs",
  "/perception",
  "/vision_stream",
  "/schema",
  "/phone_link/status",
]);

const POST_ENDPOINTS = new Set([
  "/perception_control",
  "/vision_stream_control",
  "/open_application",
  "/open_settings",
  "/execute_powershell_safe",
  "/clipboard",
  "/notify_toast",
  "/window_control",
  "/screenshot",
  "/input_control",
  "/ui_inspect",
  "/ui_interact",
  "/ui_wait",
  "/ui_capture",
  "/play_media",
  "/now_playing",
  "/vision_click",
  "/whatsapp/contacts",
  "/whatsapp/messages",
  "/whatsapp/reply",
  "/whatsapp/statuses",
  "/whatsapp/status",
  "/phone_link/reply",
  "/notifications/live",
]);

export type LuminaBridgeMethod = "GET" | "POST";

export type LuminaBridgeEndpoint =
  | "/health"
  | "/processes"
  | "/camera_devices"
  | "/logs"
  | "/perception"
  | "/vision_stream"
  | "/schema"
  | "/perception_control"
  | "/vision_stream_control"
  | "/open_application"
  | "/open_settings"
  | "/execute_powershell_safe"
  | "/clipboard"
  | "/notify_toast"
  | "/window_control"
  | "/screenshot"
  | "/input_control"
  | "/ui_inspect"
  | "/ui_interact"
  | "/ui_wait"
  | "/ui_capture"
  | "/play_media"
  | "/now_playing"
  | "/vision_click"
  | "/whatsapp/contacts"
  | "/whatsapp/messages"
  | "/whatsapp/reply"
  | "/whatsapp/statuses"
  | "/whatsapp/status"
  | "/phone_link/status"
  | "/phone_link/reply"
  | "/notifications/live";

export type LuminaBridgeCallArgs = {
  endpoint: LuminaBridgeEndpoint;
  body?: Record<string, unknown>;
  bridgeUrl?: string;
};

function toFilePath(candidate: string): string {
  if (candidate.startsWith("file://")) {
    return fileURLToPath(candidate);
  }

  return candidate;
}

function getCandidateEnvFiles(workspaceDirs: string[]): string[] {
  const roots = [
    ...workspaceDirs.map(toFilePath),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
  ];
  const envFiles = new Set<string>();

  for (const root of roots) {
    let current = path.resolve(root);

    while (true) {
      envFiles.add(path.join(current, ".env"));

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return [...envFiles];
}

function readBridgeUrlFromEnvFile(filepath: string): string | undefined {
  if (!fs.existsSync(filepath)) {
    return undefined;
  }

  const parsed = dotenv.parse(fs.readFileSync(filepath));
  const explicitUrl = parsed.LUMINA_BRIDGE_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const port = parsed.LUMINA_BRIDGE_PORT?.trim();
  if (port) {
    return `http://127.0.0.1:${port}`;
  }

  return undefined;
}

export function resolveLuminaBridgeUrl(workspaceDirs: string[]): string {
  const explicitUrl = process.env.LUMINA_BRIDGE_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const port = process.env.LUMINA_BRIDGE_PORT?.trim();
  if (port) {
    return `http://127.0.0.1:${port}`;
  }

  for (const envFile of getCandidateEnvFiles(workspaceDirs)) {
    const bridgeUrl = readBridgeUrlFromEnvFile(envFile);
    if (bridgeUrl) {
      return bridgeUrl;
    }
  }

  return DEFAULT_LUMINA_BRIDGE_URL;
}

function normalizeEndpoint(endpoint: string): LuminaBridgeEndpoint {
  const normalized = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (!GET_ENDPOINTS.has(normalized) && !POST_ENDPOINTS.has(normalized)) {
    throw new Error(`Unsupported Lumina Bridge endpoint: ${endpoint}`);
  }

  return normalized as LuminaBridgeEndpoint;
}

function normalizeBridgeUrl(url: string): string {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Lumina Bridge URL must point to localhost.");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function getMethod(endpoint: LuminaBridgeEndpoint): LuminaBridgeMethod {
  return GET_ENDPOINTS.has(endpoint) ? "GET" : "POST";
}

export async function callLuminaBridge(
  fetch: FetchFunction,
  args: LuminaBridgeCallArgs,
  fallbackBridgeUrl: string,
): Promise<unknown> {
  const endpoint = normalizeEndpoint(args.endpoint);
  const bridgeUrl = normalizeBridgeUrl(args.bridgeUrl || fallbackBridgeUrl);
  const method = getMethod(endpoint);
  const response = await fetch(`${bridgeUrl}${endpoint}`, {
    method,
    headers:
      method === "POST"
        ? {
            "Content-Type": "application/json",
          }
        : undefined,
    body: method === "POST" ? JSON.stringify(args.body ?? {}) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(
      `Lumina Bridge ${endpoint} failed with HTTP ${response.status}: ${text}`,
    );
  }

  return data;
}
