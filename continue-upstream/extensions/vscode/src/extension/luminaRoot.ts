/**
 * luminaRoot.ts — Señalar a `core` dónde está el `.env` de la raíz.
 *
 * `luminaEnv.ts` resuelve las claves subiendo desde el cwd del host y desde la
 * ubicación del propio módulo. Ese segundo camino funciona mientras la
 * extensión se ejecuta desde el árbol del repositorio (modo desarrollo), pero
 * deja de funcionar en cuanto se instala un VSIX: el bundle pasa a vivir en
 * `~/.vscode/extensions/...`, y ahí arriba no hay ningún `.env`. El resultado
 * son todas las claves a `undefined` con el archivo perfectamente puesto —el
 * mismo fallo que en su día dejó `search_web` devolviendo `search_unavailable`.
 *
 * `LUMINA_ROOT` es la red de seguridad explícita que `luminaEnv.ts` ya
 * contempla y prioriza. Aquí simplemente se rellena a partir de la carpeta
 * abierta en el editor, que es donde vive el repositorio.
 *
 * Sin dependencia de `vscode` a propósito: el llamante pasa las rutas, así el
 * recorrido se puede probar con vitest.
 */
import fs from "fs";
import path from "path";

/** Primer ancestro de `start` (incluido) que contiene un `.env`. */
export function nearestEnvRoot(start: string): string | undefined {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".env"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Exporta `LUMINA_ROOT` a partir de la primera carpeta que tenga un `.env`.
 *
 * Respeta cualquier override que ya venga del entorno: si el usuario o el
 * lanzador han fijado `LUMINA_ROOT` o `LUMINA_ENV_FILE`, mandan ellos.
 * Devuelve la raíz elegida, o `undefined` si no había ninguna.
 */
export function exportLuminaRoot(
  candidateDirs: readonly string[],
): string | undefined {
  const alreadySet = process.env.LUMINA_ROOT?.trim();
  if (alreadySet || process.env.LUMINA_ENV_FILE?.trim()) {
    return alreadySet || undefined;
  }

  for (const dir of candidateDirs) {
    if (!dir) {
      continue;
    }
    const root = nearestEnvRoot(dir);
    if (root) {
      process.env.LUMINA_ROOT = root;
      return root;
    }
  }
  return undefined;
}
