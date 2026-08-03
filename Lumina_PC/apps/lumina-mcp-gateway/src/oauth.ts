import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { config } from "./config.ts";

/**
 * Minimal OAuth 2.1 authorization server for the Claude app custom connector.
 *
 * Claude requires OAuth for remote MCP servers: it performs Dynamic Client
 * Registration (RFC 7591) + Authorization Code with PKCE (S256). This module
 * implements exactly that surface. Because the gateway can act on the user's PC,
 * the authorization step is gated by the same connector secret — Claude opens
 * the /authorize page in the user's browser, the user enters the secret once,
 * and only then is a code issued. No secret, no token.
 *
 * Clients and refresh tokens are persisted to ~/.lumina/mcp-oauth.json so a
 * gateway restart does not force Claude to reconnect.
 */

const issuer = `https://${config.publicHostname}`;
const resourceUrl = `${issuer}/mcp`;

interface ClientRecord {
  redirectUris: string[];
  name?: string;
}
interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}
interface AccessRecord {
  clientId: string;
  expiresAt: number;
}

const clients = new Map<string, ClientRecord>();
const authCodes = new Map<string, CodeRecord>();
const accessTokens = new Map<string, AccessRecord>();
const refreshTokens = new Map<string, { clientId: string }>();

const storeFile = join(homedir(), ".lumina", "mcp-oauth.json");

function loadStore(): void {
  if (!existsSync(storeFile)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as {
      clients?: [string, ClientRecord][];
      refreshTokens?: [string, { clientId: string }][];
    };
    for (const [id, record] of parsed.clients ?? []) {
      clients.set(id, record);
    }
    for (const [token, record] of parsed.refreshTokens ?? []) {
      refreshTokens.set(token, record);
    }
  } catch {
    // Corrupt store: start fresh; Claude will re-register.
  }
}

function persistStore(): void {
  try {
    mkdirSync(dirname(storeFile), { recursive: true });
    const tmp = `${storeFile}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        clients: [...clients],
        refreshTokens: [...refreshTokens],
      }),
      "utf8",
    );
    renameSync(tmp, storeFile);
  } catch {
    // Persistence is best-effort; in-memory state still works this run.
  }
}

loadStore();

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}
function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}
function sha256Base64url(input: string): string {
  return base64url(createHash("sha256").update(input).digest());
}
function secretMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function authServerMetadata(): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["lumina"],
  };
}

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resourceUrl,
    authorization_servers: [issuer],
    scopes_supported: ["lumina"],
  };
}

export function resourceMetadataUrl(): string {
  return `${issuer}/.well-known/oauth-protected-resource`;
}

export interface JsonResponse {
  status: number;
  json: unknown;
}

/** Dynamic Client Registration (RFC 7591). Public client, PKCE, no secret. */
export function handleRegister(body: unknown): JsonResponse {
  const record = (body ?? {}) as {
    redirect_uris?: unknown;
    client_name?: unknown;
  };
  const redirectUris = Array.isArray(record.redirect_uris)
    ? record.redirect_uris.filter(
        (uri): uri is string => typeof uri === "string" && uri.length > 0,
      )
    : [];
  if (redirectUris.length === 0) {
    return {
      status: 400,
      json: {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required",
      },
    };
  }
  const clientId = `lumina-${randomToken(12)}`;
  clients.set(clientId, {
    redirectUris,
    name: typeof record.client_name === "string" ? record.client_name : undefined,
  });
  persistStore();
  return {
    status: 201,
    json: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  };
}

export interface HtmlResponse {
  status: number;
  html: string;
}
export interface RedirectResponse {
  status: number;
  redirect: string;
}

function loginPage(
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
  },
  error?: string,
): string {
  const hidden = [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["state", params.state],
    ["code_challenge", params.codeChallenge],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`,
    )
    .join("");
  const errorHtml = error
    ? `<p style="color:#c0392b;margin:0 0 12px">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Autorizar Lumina</title></head>
<body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8e8ea;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<form method="POST" action="/authorize" style="background:#181b22;padding:32px;border-radius:16px;max-width:360px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.4)">
<h1 style="font-size:20px;margin:0 0 8px">Conectar Lumina con Claude</h1>
<p style="opacity:.7;margin:0 0 20px;font-size:14px">Introduce tu secreto de conector para autorizar el acceso a tu PC.</p>
${errorHtml}
${hidden}
<input type="password" name="secret" placeholder="Secreto del conector" autofocus required
 style="width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #333;background:#0f1115;color:#e8e8ea;margin-bottom:16px" />
<button type="submit" style="width:100%;padding:12px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;font-size:15px;cursor:pointer">Autorizar</button>
</form></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8" /><title>Lumina</title></head>
<body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8e8ea;display:flex;min-height:100vh;align-items:center;justify-content:center">
<p>${escapeHtml(message)}</p></body></html>`;
}

/** GET /authorize — render the secret-gated approval page. */
export function handleAuthorizeGet(
  query: URLSearchParams,
): HtmlResponse {
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  const state = query.get("state") ?? "";
  const codeChallenge = query.get("code_challenge") ?? "";
  const method = query.get("code_challenge_method") ?? "S256";

  const client = clients.get(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return { status: 400, html: errorPage("Cliente o redirect_uri inválido.") };
  }
  if (!codeChallenge || method !== "S256") {
    return { status: 400, html: errorPage("Falta PKCE (S256).") };
  }
  return {
    status: 200,
    html: loginPage({ clientId, redirectUri, state, codeChallenge }),
  };
}

/** POST /authorize — verify the secret and issue an authorization code. */
export function handleAuthorizeSubmit(
  form: Record<string, string>,
): HtmlResponse | RedirectResponse {
  const clientId = form.client_id ?? "";
  const redirectUri = form.redirect_uri ?? "";
  const state = form.state ?? "";
  const codeChallenge = form.code_challenge ?? "";
  const secret = form.secret ?? "";

  const client = clients.get(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return { status: 400, html: errorPage("Cliente o redirect_uri inválido.") };
  }
  if (!secretMatches(secret)) {
    return {
      status: 401,
      html: loginPage(
        { clientId, redirectUri, state, codeChallenge },
        "Secreto incorrecto. Inténtalo de nuevo.",
      ),
    };
  }
  const code = randomToken(24);
  authCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    expiresAt: Date.now() + 600_000,
  });
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) {
    url.searchParams.set("state", state);
  }
  return { status: 302, redirect: url.href };
}

function issueTokens(clientId: string): Record<string, unknown> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  accessTokens.set(accessToken, {
    clientId,
    expiresAt: Date.now() + 3_600_000,
  });
  refreshTokens.set(refreshToken, { clientId });
  persistStore();
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: "lumina",
  };
}

/** POST /token — authorization_code (with PKCE) and refresh_token grants. */
export function handleToken(body: Record<string, string>): JsonResponse {
  const grantType = body.grant_type ?? "";

  if (grantType === "authorization_code") {
    const code = body.code ?? "";
    const verifier = body.code_verifier ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const record = authCodes.get(code);
    if (!record || record.expiresAt < Date.now()) {
      return { status: 400, json: { error: "invalid_grant" } };
    }
    authCodes.delete(code);
    if (record.redirectUri !== redirectUri) {
      return {
        status: 400,
        json: { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      };
    }
    if (!verifier || sha256Base64url(verifier) !== record.codeChallenge) {
      return {
        status: 400,
        json: { error: "invalid_grant", error_description: "PKCE verification failed" },
      };
    }
    return { status: 200, json: issueTokens(record.clientId) };
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.refresh_token ?? "";
    const record = refreshTokens.get(refreshToken);
    if (!record) {
      return { status: 400, json: { error: "invalid_grant" } };
    }
    return { status: 200, json: issueTokens(record.clientId) };
  }

  return { status: 400, json: { error: "unsupported_grant_type" } };
}

/** True when the bearer token was issued by us and has not expired. */
export function verifyBearerToken(token: string): boolean {
  const record = accessTokens.get(token);
  if (!record) {
    return false;
  }
  if (record.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}
