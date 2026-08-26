// Validación de Start Talk antes de compilar el orbe nativo.
//
// Este script validaba una generación anterior del proyecto: una UI escrita a
// mano (`start-talk-ui.js`/`.css`), un `runtime_services.rs` y una copia del
// Windows Bridge dentro de esta carpeta. Nada de eso existe ya — la UI del orbe
// es el bundle de `continue-upstream/gui`, el puente vive en
// `Lumina_PC/apps/lumina-windows-bridge` y el shell nativo inyecta el puente
// WebSocket desde `lib.rs`. Fallaba entero, así que `npm run check` y con él
// `scripts/build-native.ps1` estaban rotos.
//
// Lo que se comprueba ahora es lo que de verdad rompe el orbe si se desalinea.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const guiDist = resolve(root, "..", "continue-upstream", "gui", "dist");
const failures = [];
const warnings = [];

function read(relativePath) {
  try {
    return readFileSync(resolve(root, relativePath), "utf8");
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
    return "";
  }
}

function requireFile(relativePath) {
  const absolutePath = resolve(root, relativePath);
  try {
    if (!statSync(absolutePath).isFile()) {
      failures.push(`${relativePath}: no es un archivo`);
    }
  } catch {
    failures.push(`${relativePath}: no existe`);
  }
}

const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json") || "{}");
const frontendHtml = read("orb-frontend/index.html");
const nativeShell = read("src-tauri/src/lib.rs");

if (tauriConfig.build?.frontendDist !== "../orb-frontend") {
  failures.push("Tauri debe empaquetar ../orb-frontend");
}

// El fallo silencioso más caro: el bundle se reconstruye con otros nombres de
// entrada y el index.html del orbe sigue pidiendo los viejos. La ventana abre
// en negro y nada falla durante la compilación. Se comprueba contra el propio
// HTML en vez de contra una lista fija, así no hay nada que mantener aquí.
const referenced = [
  ...frontendHtml.matchAll(/(?:src|href)="(\/[^"]+)"/gu),
].map((match) => match[1]);

if (referenced.length === 0 && frontendHtml) {
  failures.push("orb-frontend/index.html no carga ningún recurso");
}

for (const reference of referenced) {
  if (existsSync(resolve(root, "orb-frontend", `.${reference}`))) {
    continue;
  }
  // Un icono que falta deja un 404 en la pestaña; un script o una hoja de
  // estilos que falta deja la ventana en negro. No son el mismo problema.
  const isIcon = /\.(png|svg|ico)$/iu.test(reference);
  const message = `orb-frontend${reference}: lo pide index.html y no existe`;
  if (isIcon) {
    warnings.push(message);
  } else {
    failures.push(message);
  }
}

// El index.html del orbe SALE de gui/dist, no es un shim escrito a mano: el
// puente `window.vscode` lo inyecta lib.rs. Si el bundle se reconstruye y no se
// vuelve a copiar el HTML, el orbe queda pidiendo la entrada anterior.
if (existsSync(guiDist)) {
  const built = resolve(guiDist, "index.html");
  if (existsSync(built) && readFileSync(built, "utf8") !== frontendHtml) {
    failures.push(
      "orb-frontend/index.html no coincide con gui/dist/index.html: vuelve a ensamblar orb-frontend",
    );
  }
}

for (const asset of [
  "orb-frontend/assets/index.js",
  "orb-frontend/assets/index.css",
  "orb-frontend/lumina-icon.png",
]) {
  requireFile(asset);
}

for (const integration of [
  "integrations/voice_bridge.py",
  "integrations/read_codex_response_aloud.py",
  "integrations/read_claude_response_aloud.py",
  "services/chat-response-monitor.mjs",
  "services/chat-response-parsers.mjs",
  "services/delegation-policy.cjs",
  "services/delegation-policy.test.mjs",
]) {
  requireFile(integration);
}

// Sin esto la ventana abre pero no habla con Lumina Code: es el puente entero.
if (!nativeShell.includes("LUMINA_ORB_BRIDGE")) {
  failures.push("lib.rs no inyecta el puente LUMINA_ORB_BRIDGE en el webview");
}

// El frontend va EMBEBIDO en el exe: uno más viejo que el bundle está
// ejecutando la UI anterior aunque los fuentes estén al día.
const exePath = resolve(root, "src-tauri/target/release/start-talk.exe");
const bundlePath = resolve(root, "orb-frontend/assets/index.js");
if (existsSync(exePath) && existsSync(bundlePath)) {
  if (statSync(exePath).mtimeMs < statSync(bundlePath).mtimeMs) {
    warnings.push(
      "start-talk.exe es más viejo que orb-frontend/assets/index.js: embebe la UI anterior",
    );
  }
}

for (const warning of warnings) {
  console.warn(`aviso: ${warning}`);
}

if (failures.length > 0) {
  console.error("\nStart Talk no paso la validacion:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Start Talk validado: bundle, shell nativo, servicios e integraciones alineados.");
