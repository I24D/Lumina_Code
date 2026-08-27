// Conserva como máximo una copia ejecutable de Start Talk.
//
// Cargo deja una copia interna en `release/deps/start_talk.exe` y durante el
// desarrollo se llegaron a crear `debug/start-talk.exe` y
// `release/start-talk.old.exe`. Ninguna debe ser lanzada: la única salida
// canónica es `release/start-talk.exe`.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const canonical = resolve(
  root,
  "src-tauri",
  "target",
  "release",
  "start-talk.exe",
);
const targetRoot = resolve(root, "src-tauri", "target");
const releaseRoot = resolve(targetRoot, "release");

const removed = [];
for (const entry of existsSync(targetRoot)
  ? readdirSync(targetRoot, { withFileTypes: true })
  : []) {
  const absolutePath = resolve(targetRoot, entry.name);
  if (absolutePath === releaseRoot) {
    for (const releaseEntry of readdirSync(releaseRoot, {
      withFileTypes: true,
    })) {
      const releasePath = resolve(releaseRoot, releaseEntry.name);
      if (releasePath === canonical) {
        continue;
      }
      rmSync(releasePath, {
        force: true,
        recursive: releaseEntry.isDirectory(),
      });
      removed.push(`src-tauri/target/release/${releaseEntry.name}`);
    }
    continue;
  }
  rmSync(absolutePath, { force: true, recursive: entry.isDirectory() });
  removed.push(`src-tauri/target/${entry.name}`);
}

console.log(
  removed.length > 0
    ? `Artefactos binarios eliminados: ${removed.join(", ")}`
    : existsSync(canonical)
      ? "Artefactos de Start Talk limpios: solo existe el release canónico."
      : "Artefactos de Start Talk limpios: aún no existe un release canónico.",
);
