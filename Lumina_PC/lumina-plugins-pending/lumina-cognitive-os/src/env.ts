/**
 * env.ts — Loader for the single I24D .env file.
 *
 * All Lumina extensions point at the same `.env` so secrets and feature
 * flags live in ONE place: `c:/I24D_WhatsApp/.env`.
 *
 * No external dotenv dependency: we parse the format ourselves (simple
 * KEY=VALUE pairs, # comments, blank lines, optional quoting).
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENV_PATH = "c:/I24D_WhatsApp/.env";

let cachedEnv: Readonly<Record<string, string>> | null = null;
let cachedSource: string | null = null;

function resolveEnvPath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const drive = normalized.match(/^([a-zA-Z]):\/(.+)$/);
  if (drive && process.platform !== "win32") {
    return `/mnt/${drive[1]?.toLowerCase()}/${drive[2]}`;
  }
  return path.resolve(input);
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip trailing inline comment that isn't inside quotes.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export type LoadEnvOptions = {
  /** Override the .env path. Default: c:/I24D_WhatsApp/.env */
  readonly envPath?: string;
  /** Force re-read from disk, bypassing cache. */
  readonly fresh?: boolean;
};

export function loadLuminaEnv(opts: LoadEnvOptions = {}): Readonly<Record<string, string>> {
  const target = resolveEnvPath(opts.envPath ?? DEFAULT_ENV_PATH);
  if (!opts.fresh && cachedEnv !== null && cachedSource === target) {
    return cachedEnv;
  }
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch {
    cachedEnv = Object.freeze({});
    cachedSource = target;
    return cachedEnv;
  }
  const parsed = parseEnvFile(content);
  cachedEnv = Object.freeze(parsed);
  cachedSource = target;
  return cachedEnv;
}

export function getLuminaEnvVar(
  name: string,
  opts: LoadEnvOptions = {},
): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess.length > 0) {
    return fromProcess;
  }
  const env = loadLuminaEnv(opts);
  const v = env[name];
  return v && v.length > 0 ? v : undefined;
}

export function requireLuminaEnvVar(name: string, opts: LoadEnvOptions = {}): string {
  const v = getLuminaEnvVar(name, opts);
  if (v === undefined) {
    throw new Error(
      `Missing env var ${name}. Add it to ${opts.envPath ?? DEFAULT_ENV_PATH}.`,
    );
  }
  return v;
}

export const LUMINA_ENV_PATH = DEFAULT_ENV_PATH;
