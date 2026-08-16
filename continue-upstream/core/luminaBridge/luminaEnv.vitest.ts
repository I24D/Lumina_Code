import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { readLuminaEnv, resetLuminaEnvCache } from "./luminaEnv.js";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  resetLuminaEnvCache();
});

/**
 * Comprueba presencia SIN exponer el valor. Un `expect(value).toBeTruthy()`
 * sobre una clave real la imprime entera en la salida cuando falla.
 */
function isPresent(key: string): boolean {
  return Boolean(readLuminaEnv(key));
}

describe("readLuminaEnv", () => {
  it("resuelve las claves con el cwd normal del repo", () => {
    expect(isPresent("TAVILY_API_KEY")).toBe(true);
  });

  it("encuentra el .env aunque el cwd esté FUERA del repo", () => {
    // Este es el fallo real que rompió search_web: el host de la extensión no
    // tiene su cwd dentro del repo, así que subir desde cwd no encontraba nada
    // y las claves salían undefined con el .env perfectamente puesto. La
    // resolución se apoya ahora en la ubicación del módulo, que siempre vive
    // dentro del repo (en fuente y empaquetado).
    process.chdir(path.parse(originalCwd).root);
    resetLuminaEnvCache();

    expect(isPresent("TAVILY_API_KEY")).toBe(true);
  });

  it("LUMINA_ROOT queda como red de seguridad explícita", () => {
    const repoRoot = path.resolve(originalCwd, "..", "..");
    process.chdir(path.parse(originalCwd).root);
    process.env.LUMINA_ROOT = repoRoot;
    resetLuminaEnvCache();

    expect(isPresent("TAVILY_API_KEY")).toBe(true);
  });

  it("process.env gana sobre el archivo", () => {
    process.env.CLAVE_DE_PRUEBA_LUMINA = "valor-de-proceso";
    resetLuminaEnvCache();

    expect(readLuminaEnv("CLAVE_DE_PRUEBA_LUMINA")).toBe("valor-de-proceso");
  });

  it("devuelve undefined para una clave inexistente", () => {
    expect(readLuminaEnv("CLAVE_QUE_NO_EXISTE_12345")).toBeUndefined();
  });

  it("un LUMINA_ENV_FILE inexistente no rompe la resolución", () => {
    process.env.LUMINA_ENV_FILE = path.join(originalCwd, "no-existe.env");
    resetLuminaEnvCache();

    expect(isPresent("TAVILY_API_KEY")).toBe(true);
  });
});
