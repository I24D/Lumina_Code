import { getLuminaEnvVar, type LoadEnvOptions } from "../env.js";

export type SupabaseKeySource =
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "SUPABASE_ANON_KEY"
  | "SUPABASE_KEY";

export type SupabaseConfig = {
  readonly url: string;
  readonly key: string;
  readonly keySource: SupabaseKeySource;
  readonly schema: string;
  readonly maxRows: number;
  readonly allowWrites: boolean;
};

export type SupabaseConfigOptions = LoadEnvOptions & {
  readonly schema?: string;
  readonly maxRows?: number;
  readonly allowWrites?: boolean;
};

export type SupabaseFetchOptions = RequestInit & {
  readonly timeoutMs?: number;
  readonly acceptOpenApi?: boolean;
};

const DEFAULT_SCHEMA = "public";
const DEFAULT_MAX_ROWS = 100;
const HARD_MAX_ROWS = 500;

export const SUPABASE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function assertSupabaseIdentifier(value: string, label: string): void {
  if (!SUPABASE_IDENTIFIER_RE.test(value)) {
    throw new Error(`${label} must be a simple PostgreSQL identifier`);
  }
}

function normalizeSupabaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseMaxRows(value: number | string | undefined): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : DEFAULT_MAX_ROWS;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ROWS;
  return Math.min(Math.trunc(parsed), HARD_MAX_ROWS);
}

export function resolveSupabaseConfig(options: SupabaseConfigOptions = {}): SupabaseConfig {
  const url = getLuminaEnvVar("SUPABASE_URL", options);
  if (!url) {
    throw new Error("Missing SUPABASE_URL");
  }

  const keyCandidates: Array<[SupabaseKeySource, string | undefined]> = [
    ["SUPABASE_SERVICE_ROLE_KEY", getLuminaEnvVar("SUPABASE_SERVICE_ROLE_KEY", options)],
    ["SUPABASE_ANON_KEY", getLuminaEnvVar("SUPABASE_ANON_KEY", options)],
    ["SUPABASE_KEY", getLuminaEnvVar("SUPABASE_KEY", options)],
  ];
  const selected = keyCandidates.find(([, value]) => typeof value === "string" && value.length > 0);
  if (!selected?.[1]) {
    throw new Error("Missing Supabase API key");
  }

  const schema =
    options.schema ??
    getLuminaEnvVar("LUMINA_SUPABASE_SCHEMA", options) ??
    getLuminaEnvVar("SUPABASE_SCHEMA", options) ??
    DEFAULT_SCHEMA;
  assertSupabaseIdentifier(schema, "schema");

  const maxRows = parseMaxRows(
    options.maxRows ?? getLuminaEnvVar("LUMINA_SUPABASE_MAX_ROWS", options),
  );
  const allowWrites = options.allowWrites ?? parseBoolean(
    getLuminaEnvVar("LUMINA_SUPABASE_ALLOW_WRITES", options),
    false,
  );

  return {
    url: normalizeSupabaseUrl(url),
    key: selected[1],
    keySource: selected[0],
    schema,
    maxRows,
    allowWrites,
  };
}

export function getSupabaseProjectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const first = host.split(".")[0];
    return first && first !== "localhost" ? first : host;
  } catch {
    return null;
  }
}

export async function supabaseFetch(
  config: SupabaseConfig,
  path: string,
  options: SupabaseFetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const headers = new Headers(options.headers);
    headers.set("apikey", config.key);
    headers.set("authorization", `Bearer ${config.key}`);
    headers.set("accept", options.acceptOpenApi ? "application/openapi+json" : "application/json");
    if (!headers.has("content-type") && options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    headers.set("accept-profile", config.schema);
    headers.set("content-profile", config.schema);

    const target = `${config.url}${path.startsWith("/") ? path : `/${path}`}`;
    return await fetch(target, {
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function readSupabaseJson<T>(
  response: Response,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: text.slice(0, 2_000) || response.statusText || `HTTP ${response.status}`,
    };
  }
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch (err) {
    return {
      ok: false,
      status: response.status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
