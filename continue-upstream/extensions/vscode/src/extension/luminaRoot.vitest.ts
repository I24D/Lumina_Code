import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportLuminaRoot, nearestEnvRoot } from "./luminaRoot";

const originalEnv = { ...process.env };
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-root-"));
  delete process.env.LUMINA_ROOT;
  delete process.env.LUMINA_ENV_FILE;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

/** Crea `<tmpRoot>/<rel>` y devuelve su ruta absoluta. */
function makeDir(rel: string): string {
  const dir = path.join(tmpRoot, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("nearestEnvRoot", () => {
  it("encuentra el .env subiendo desde una subcarpeta", () => {
    const repo = makeDir("repo");
    fs.writeFileSync(path.join(repo, ".env"), "CLAVE=valor\n");
    const deep = makeDir("repo/paquetes/extension/src");

    expect(nearestEnvRoot(deep)).toBe(repo);
  });

  it("devuelve undefined cuando no hay ningún .env por encima", () => {
    // El recorrido termina en la raíz del volumen, así que se comprueba que no
    // invente una respuesta: sólo puede fallar si la máquina tiene un .env en
    // el temporal o por encima, lo que no es el caso en un tmpdir recién hecho.
    const orphan = makeDir("sin-env/mas-abajo");

    const found = nearestEnvRoot(orphan);
    expect(found === undefined || !found.startsWith(tmpRoot)).toBe(true);
  });
});

describe("exportLuminaRoot", () => {
  it("exporta la primera carpeta que tenga un .env", () => {
    const sinEnv = makeDir("sin-env");
    const repo = makeDir("repo");
    fs.writeFileSync(path.join(repo, ".env"), "CLAVE=valor\n");

    expect(exportLuminaRoot([sinEnv, repo])).toBe(repo);
    expect(process.env.LUMINA_ROOT).toBe(repo);
  });

  it("respeta un LUMINA_ROOT ya fijado", () => {
    const repo = makeDir("repo");
    fs.writeFileSync(path.join(repo, ".env"), "CLAVE=valor\n");
    process.env.LUMINA_ROOT = "C:\\raiz\\elegida\\a\\mano";

    expect(exportLuminaRoot([repo])).toBe("C:\\raiz\\elegida\\a\\mano");
    expect(process.env.LUMINA_ROOT).toBe("C:\\raiz\\elegida\\a\\mano");
  });

  it("no pisa un LUMINA_ENV_FILE explícito", () => {
    const repo = makeDir("repo");
    fs.writeFileSync(path.join(repo, ".env"), "CLAVE=valor\n");
    process.env.LUMINA_ENV_FILE = path.join(repo, "otro.env");

    expect(exportLuminaRoot([repo])).toBeUndefined();
    expect(process.env.LUMINA_ROOT).toBeUndefined();
  });

  it("no exporta nada cuando ninguna carpeta tiene .env", () => {
    const sinEnv = makeDir("sin-env");

    exportLuminaRoot([sinEnv]);
    expect(process.env.LUMINA_ROOT).toBeUndefined();
  });
});
