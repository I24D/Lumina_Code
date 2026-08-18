import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

function read(relativePath) {
  const absolutePath = resolve(root, relativePath);
  try {
    return readFileSync(absolutePath, "utf8");
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
const uiScript = read("orb-frontend/start-talk-ui.js");
const uiStyles = read("orb-frontend/start-talk-ui.css");
const nativeShell = read("src-tauri/src/lib.rs");
const runtimeServices = read("src-tauri/src/runtime_services.rs");
const supervisor = read("services/runtime-supervisor.mjs");
const windowsBridge = read("windows-bridge/src/server.ts");
const hostBundle = read("host/dist/index.cjs");

if (tauriConfig.build?.frontendDist !== "../orb-frontend") {
  failures.push("Tauri debe empaquetar ../orb-frontend");
}

for (const requiredText of ["/start-talk-ui.js", "/start-talk-ui.css"]) {
  if (!frontendHtml.includes(requiredText)) {
    failures.push(`orb-frontend/index.html no carga ${requiredText}`);
  }
}

if (!uiScript.includes('main [aria-live="polite"]')) {
  failures.push("start-talk-ui.js no identifica el transcript en vivo");
}

for (const region of ["stage", "transcript", "activity"]) {
  if (!uiStyles.includes(`data-start-talk-region="${region}"`)) {
    failures.push(`start-talk-ui.css no contiene la region ${region}`);
  }
}

for (const asset of [
  "orb-frontend/assets/index.js",
  "orb-frontend/assets/index.js.map",
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
  "windows-bridge/sidecars/notification_listener.py",
]) {
  requireFile(integration);
}

if (!nativeShell.includes("ensure_runtime_services")) {
  failures.push("el shell nativo no inicia los servicios standalone");
}

if (!runtimeServices.includes("runtime-supervisor.mjs")) {
  failures.push("runtime_services.rs no localiza el supervisor");
}

if (!supervisor.includes('"chat-response-monitor.mjs"')) {
  failures.push("el supervisor no mantiene activo el monitor de chats");
}

for (const serviceParts of [
  ["windows-bridge", "src", "server.ts"],
  ["host", "dist", "index.cjs"],
]) {
  if (!serviceParts.every((part) => supervisor.includes(`"${part}"`))) {
    failures.push(`el supervisor no contiene ${serviceParts.join("/")}`);
  }
}

for (const endpoint of ["/notifications/live", "/voice/claude-response", "/voice/response"]) {
  if (!windowsBridge.includes(endpoint)) {
    failures.push(`el Windows Bridge no expone ${endpoint}`);
  }
}

if (!hostBundle.includes('"gemini-3.1-flash-live-preview"') ||
    !hostBundle.includes("SEARCH_SUPPORTED_MODELS")) {
  failures.push("Gemini 3.1 Flash Live debe conservar Google Search habilitado");
}

if (hostBundle.includes(
  'SEARCH_INCOMPATIBLE_MODELS = ["gemini-3.1-flash-live-preview"]',
)) {
  failures.push("Gemini 3.1 Flash Live no debe estar en la lista negra de búsqueda");
}

if (!hostBundle.includes("tools.push({ googleSearch: {} })")) {
  failures.push("el host standalone no incluye la herramienta nativa Google Search");
}

if (!hostBundle.includes("authorizeDelegation") ||
    !hostBundle.includes("delegation_not_authorized")) {
  failures.push("el host no bloquea delegaciones no solicitadas antes de ejecutarlas");
}

if (!hostBundle.includes(
  "You are Lumina Live, the standalone voice assistant inside Start Talk.",
)) {
  failures.push("el prompt de voz no debe presentarse como Lumina Code dentro de VS Code");
}

if (!uiScript.includes("búsqueda web en vivo")) {
  failures.push("la descripción de Flash Live 3.1 no anuncia Google Search");
}

if (failures.length > 0) {
  console.error("Start Talk no paso la validacion:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Start Talk validado: UI nativa, servicios, integraciones y assets listos.");
