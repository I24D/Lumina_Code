import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration + secret management for the Lumina MCP Gateway.
 *
 * The gateway loads the single canonical env file at the I24D_WhatsApp repo root
 * (never a local .env) and derives every upstream URL from it. A long random
 * connector secret is generated once and persisted to ~/.lumina so the public
 * URL stays stable across restarts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here); // lumina-mcp-gateway/
// lumina-mcp-gateway -> apps -> Lumina_PC -> I24D_WhatsApp. Derived from this
// file's location (NOT LUMINA_REPO_ROOT, which points at Lumina_PC) so the
// single canonical .env is always found, standalone or under dev:all.
const repoRoot = resolve(appRoot, "..", "..", "..");

function loadEnvFile(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Canonical env file lives at c:/I24D_WhatsApp/.env.
loadEnvFile(process.env.I24D_ENV_FILE ?? resolve(repoRoot, ".env"));

const luminaDir = join(homedir(), ".lumina");
const secretFile = join(luminaDir, "mcp-gateway-secret.txt");

function loadOrCreateSecret(): string {
  const fromEnv = process.env.MCP_GATEWAY_SECRET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (existsSync(secretFile)) {
    const stored = readFileSync(secretFile, "utf8").trim();
    if (stored) {
      return stored;
    }
  }
  const secret = randomBytes(24).toString("base64url");
  mkdirSync(luminaDir, { recursive: true });
  const tmp = `${secretFile}.tmp`;
  writeFileSync(tmp, secret, "utf8");
  renameSync(tmp, secretFile);
  return secret;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

export const config = {
  /** Loopback bind — the Cloudflare tunnel connects to it locally. */
  host: process.env.MCP_GATEWAY_HOST ?? "127.0.0.1",
  port: Number(process.env.MCP_GATEWAY_PORT ?? "8808"),
  /** Shared secret embedded in the connector URL path (and accepted as Bearer). */
  secret: loadOrCreateSecret(),
  /** Windows bridge (native PC actions: WhatsApp, UI, screenshots). */
  bridgeUrl: stripTrailingSlash(
    process.env.LUMINA_BRIDGE_URL ?? "http://127.0.0.1:8765",
  ),
  /** I24D backend (unified memory + identity). */
  coreUrl: stripTrailingSlash(
    process.env.LUMINA_CORE_URL ?? "http://127.0.0.1:3000",
  ),
  /** Coordinates file the VS Code extension publishes for the chat WS surface. */
  chatBridgeFile: join(luminaDir, "mcp-bridge.json"),
  /** Default owner identity used for memory reads/writes when unspecified. */
  defaultUserId: process.env.LUMINA_DEFAULT_USER_ID ?? "owner",
  /** Public hostname exposed by the Cloudflare tunnel (for the printed URL). */
  publicHostname: process.env.MCP_GATEWAY_PUBLIC_HOST ?? "mcp.luminaopenia.com",
};

export type LuminaGatewayConfig = typeof config;
