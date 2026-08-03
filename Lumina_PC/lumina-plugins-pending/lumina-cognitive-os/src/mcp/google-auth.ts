/**
 * google-auth.ts — Common OAuth helper for Gmail/Calendar/Drive tools.
 *
 * Reads from c:/I24D_WhatsApp/.env:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *   (Optional) GOOGLE_ACCESS_TOKEN  — used until exchange refreshes it
 *
 * We never persist access tokens to disk — they live only in memory for
 * one process. Refresh token comes from the user's existing setup
 * (Google Cloud Console "OAuth 2.0 Client ID" with the right scopes).
 */
import { getLuminaEnvVar } from "../env.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

export async function getGoogleAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > Date.now() + 30_000) {
    return cachedAccessToken.token;
  }
  const clientId = getLuminaEnvVar("GOOGLE_CLIENT_ID");
  const clientSecret = getLuminaEnvVar("GOOGLE_CLIENT_SECRET");
  const refreshToken = getLuminaEnvVar("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in c:/I24D_WhatsApp/.env",
    );
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`google token refresh failed: ${r.status} ${text}`);
  }
  const json = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("google token refresh returned no access_token");
  }
  cachedAccessToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.max(60, (json.expires_in ?? 3600)) * 1000,
  };
  return json.access_token;
}

export async function googleFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getGoogleAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}
