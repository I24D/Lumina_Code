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

// Legacy fallbacks from when the project lived at C:\I24D_WhatsApp. Harmless if
// absent, kept only so an old checkout still resolves.
const CANONICAL_ROOTS = [
  "C:\\I24D_WhatsApp",
  "/c/I24D_WhatsApp",
  "/mnt/c/I24D_WhatsApp",
];

/** Añade `dir` y todos sus ancestros al conjunto de raíces candidatas. */
function addAncestors(roots: Set<string>, dir: string): void {
  let current = dir;
  while (true) {
    roots.add(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

/**
 * Directorio de ESTE módulo, cuando se puede saber.
 *
 * Es la pieza que faltaba: subir desde `process.cwd()` NO sirve en el host de
 * la extensión, cuyo cwd no tiene por qué estar dentro del repo (se observó
 * `search_web` devolviendo `search_unavailable` con las claves perfectamente
 * puestas en el `.env`, solo porque el archivo no se encontraba). El módulo, en
 * cambio, siempre vive dentro del repo: en fuente bajo `core/luminaBridge/` y
 * empaquetado bajo `extensions/vscode/out/`. Desde cualquiera de los dos se
 * llega a la raíz subiendo.
 */
function moduleDir(): string | undefined {
  // El bundle de la extensión es CJS, así que aquí `__dirname` existe y apunta
  // a `extensions/vscode/out`. En ESM (vitest, fuente directo) no existe, pero
  // ahí el cwd ya cae dentro del repo y la búsqueda por ancestros basta.
  return typeof __dirname === "string" ? __dirname : undefined;
}

function candidateEnvFiles(): string[] {
  const roots = new Set<string>();
  // Override explícito: gana sobre cualquier heurística.
  const explicitRoot = process.env.LUMINA_ROOT?.trim();
  if (explicitRoot) {
    roots.add(explicitRoot);
  }
  addAncestors(roots, process.cwd());
  const here = moduleDir();
  if (here) {
    addAncestors(roots, here);
  }
  for (const root of CANONICAL_ROOTS) {
    roots.add(root);
  }

  const files = [...roots].map((root) => path.join(root, ".env"));
  // Un archivo apuntado a dedo tiene prioridad absoluta.
  const explicitFile = process.env.LUMINA_ENV_FILE?.trim();
  return explicitFile ? [explicitFile, ...files] : files;
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
