/**
 * luminaEnv.ts — Read Lumina capability keys from the single root `.env`.
 *
 * Lumina Code's real-world capabilities (web research, image/video generation)
 * are powered by provider keys that live in the ONE canonical env file at the
 * project root (`c:/I24D_WhatsApp/.env`). The VS Code extension host doesn't
 * auto-load a project `.env`, so this helper resolves keys itself:
 *   1. process.env (if the launcher already exported it), then
 *   2. the nearest `.env` walking up from cwd, then
 *   3. the canonical root path as a last resort.
 *
 * Values are parsed once and cached. This is deliberately dependency-light so
 * every tool (searchWeb → Tavily, image/video gen) shares one source of truth.
 */
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";

let cache: Record<string, string> | null = null;

// Canonical fallbacks — the project keeps a single root .env (see memory rule
// "single .env at repo root"). Kept here so a tool works even when the
// extension host's cwd is the extension dir rather than the project root.
const CANONICAL_ROOTS = [
  "C:\\I24D_WhatsApp",
  "/c/I24D_WhatsApp",
  "/mnt/c/I24D_WhatsApp",
];

function candidateEnvFiles(): string[] {
  const roots = new Set<string>();
  let current = process.cwd();
  while (true) {
    roots.add(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  for (const root of CANONICAL_ROOTS) {
    roots.add(root);
  }
  return [...roots].map((root) => path.join(root, ".env"));
}

function loadRootEnv(): Record<string, string> {
  if (cache) {
    return cache;
  }
  const merged: Record<string, string> = {};
  for (const file of candidateEnvFiles()) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const parsed = dotenv.parse(fs.readFileSync(file));
      for (const [key, value] of Object.entries(parsed)) {
        // First file wins (nearest to cwd), so don't overwrite.
        if (!(key in merged)) {
          merged[key] = value;
        }
      }
    } catch {
      // Unreadable/ malformed env file — skip, never throw from a getter.
    }
  }
  cache = merged;
  return merged;
}

/** Read a single key from process.env or the root .env. Trimmed; undefined if empty. */
export function readLuminaEnv(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.trim()) {
    return fromProcess.trim();
  }
  const value = loadRootEnv()[key];
  return value && value.trim() ? value.trim() : undefined;
}

/** Read the first key that has a value, in priority order. */
export function readLuminaEnvFirst(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readLuminaEnv(key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** Reset the cache (tests / after an env change). */
export function resetLuminaEnvCache(): void {
  cache = null;
}
